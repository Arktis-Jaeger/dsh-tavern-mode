/**
 * 酒馆模式的 Host 半边：预设默认 System Prompt + 对话级自定义 System Prompt。
 *
 * 这一行按 `@deepseek-ai/dsh-agent-preset` 的 `config.plugins` 挂在**预设作用域**
 * 内，因此它只在「酒馆模式」预设被激活时存在：
 *
 * 1. 预设默认值来自本行的 `config.defaultPrompt`，也就是预设声明自身的一部分。
 * 2. 每段对话的覆盖值注册在该 Agent 自己的 `agent.ctx` 上，用共享的段落名
 *    `deployment:persona-prefix` 遮蔽预设层与部署层的默认人设 —— 这正是
 *    `dsh-system-prompt` 的错误信息所指的「per-agent override」路径。
 * 3. 覆盖值持久化在 `tavern_prompt` 存储域里（每 SessionId 一条记录）。
 * 4. 浏览器半边通过 `ctx.webServer` 上的一条精确路由读取与写入，路由自己做
 *    `ctx.connection.admit()` 的 Host/Origin 与浏览器会话校验。
 *
 * ## 关于 import 与 Config
 *
 * 本包是 `link:` 进 profile 的「linked package」，`dsh-app-boot` 的解析拦截层只在
 * 本包的 `peerDependencies` 声明了名字时才把请求路由到 DSH 安装目录，所以这里
 * import 的两个出货包都已在 `package.json` 里声明为 peer（出货包由 dsh 安装提供，
 * 不再装一份）。
 *
 * 段落名与排序都取自共享契约：`PERSONA_PREFIX_SECTION` 正是
 * `@deepseek-ai/dsh-system-prompt` 为「组装方替换这个槽位」而导出的常量，顺序则向
 * 活的注册表查询，避免任何本地硬编码漂移。
 *
 * 该段落以 `interpolate: false` 注册：角色扮演提示词里出现 `{{char}}` 这类花括号
 * 是常态，不能被提示词变量插值当成引用而抛错。
 */
import z from '@deepseek-ai/schemastery'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { promptDomainSpec, PROMPT_TABLE_NAME } from './prompt-store.js'

/** 与该段落配套的中心化排序名，实际顺序通过 `systemPrompt` 服务查询。 */
const PERSONA_PREFIX_ORDER_NAME = 'DEPLOYMENT_PERSONA_PREFIX'

/** 存储层的 per-record 键约束（`dsh-storage-json` 的 `SAFE_KEY_RE`）。 */
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/

/** Cordis 插件名与硬依赖。`connection`、`agentPresets` 是可选的。 */
export const name = 'tavern-system-prompt'
export const inject = ['systemPrompt', 'storageDomain', 'webServer']

export const Config = z.object({
  /** 该预设的标识符；只有绑定到它的 Agent 才会拿到自定义段落。 */
  presetId: z.string().default('tavern'),
  /** 预设自带的默认 System Prompt。 */
  defaultPrompt: z.string().default(''),
  /** 浏览器半边使用的精确路由路径。 */
  routePath: z.string().default('/tavern-mode/system-prompt'),
  /** 单段自定义提示词的字符上限。 */
  maxPromptChars: z.natural().default(200000),
  /** 请求体字节上限。 */
  bodyLimitBytes: z.natural().default(4194304),
})

/**
 * 注册酒馆模式的提示词与读写通道。
 * @param ctx - 预设作用域上下文。
 * @param config - 预设声明里这一行的 `config`，已由 {@link Config} 补全。
 */
export function apply(ctx, config) {
  const { presetId, defaultPrompt, routePath, maxPromptChars, bodyLimitBytes } = config

  /** SessionId -> { text, updatedAt }；存储域的内存镜像，读取保持同步。 */
  const custom = new Map()
  /** 已打开的 `prompts` 表；打开失败时保持 `null`。 */
  let table = null
  /** 存储层不可用时的诊断文本。 */
  let storeFailure = null

  const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

  /**
   * 打开存储域并把内存镜像填满；永不 reject，失败只记录诊断。
   *
   * 一个进程里同名域只能打开一次，因此热重载时上一代 fiber 可能还没来得及释放
   * 它。对 `already-open` 做几次退避重试，最后退回设施里那个已打开的句柄；
   * 若那个句柄随后被关闭，写失败会明确报错，而不是静默丢数据。
   */
  const storeReady = (async () => {
    let domain
    for (let attempt = 0; attempt < 4 && domain === undefined; attempt += 1) {
      if (attempt > 0) await sleep(25 * attempt)
      try {
        domain = await ctx.storageDomain.open(promptDomainSpec)
        ctx.effect(() => () => domain.close(), 'tavern-system-prompt: close domain')
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (!/already-open/.test(reason)) {
          storeFailure = reason
          break
        }
      }
    }
    if (domain === undefined) domain = ctx.storageDomain.get(promptDomainSpec.name)
    if (domain === undefined) {
      if (storeFailure === null) storeFailure = `domain '${promptDomainSpec.name}' could not be opened`
      ctx.logger.warn('tavern-system-prompt: per-conversation store unavailable: ' + storeFailure)
      return
    }
    try {
      const opened = domain.table(PROMPT_TABLE_NAME)
      for (const [key, value] of opened.entries()) custom.set(key, value)
      table = opened
    } catch (error) {
      storeFailure = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('tavern-system-prompt: per-conversation store unavailable: ' + storeFailure)
    }
  })()

  /** 该 Agent 是否由本预设绑定。作用域派发已做主要过滤，这里只是二次保险。 */
  const isTavernAgent = (agent) => {
    const presets = ctx.get('agentPresets')
    if (presets === undefined) return true
    try {
      const composed = presets.composedPreset(agent.ctx)
      return composed === undefined || composed === presetId
    } catch {
      return false
    }
  }

  /** Agent 卸载时由 Agent 作用域自行回收；插件卸载时由下面这个 effect 兜底。 */
  const sectionDisposers = new Map()
  ctx.effect(() => () => {
    for (const dispose of sectionDisposers.values()) dispose()
    sectionDisposers.clear()
  }, 'tavern-system-prompt: dispose per-agent sections')

  ctx.on('agent/created', ({ agent }) => {
    if (!isTavernAgent(agent)) return
    const order = agent.ctx.systemPrompt.getSectionOrder(PERSONA_PREFIX_ORDER_NAME)
    if (!Number.isFinite(order)) {
      ctx.logger.warn(`tavern-system-prompt: the prompt registry has no section order named ${PERSONA_PREFIX_ORDER_NAME}; falling back to 0`)
    }
    const section = {
      name: PERSONA_PREFIX_SECTION,
      order: Number.isFinite(order) ? order : 0,
      // 每次组装都重新求值，因此保存后无需重注册即可在下一步生效。
      text: () => custom.get(agent.id)?.text ?? defaultPrompt,
      interpolate: false,
    }
    const dispose = agent.ctx.effect(
      () => agent.ctx.systemPrompt.section(section),
      'tavern-system-prompt: per-conversation persona section',
    )
    sectionDisposers.set(agent.id, () => {
      sectionDisposers.delete(agent.id)
      dispose()
    })
  })

  const fail = (code, message) => ({ ok: false, error: { code, message } })

  const send = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  /** 组装一次响应所需的完整状态。 */
  const stateOf = (sessionId) => {
    const record = custom.get(sessionId)
    return {
      sessionId,
      custom: record === undefined ? null : record.text,
      effective: record === undefined ? defaultPrompt : record.text,
      default: defaultPrompt,
      updatedAt: record === undefined ? null : record.updatedAt,
      store: table === null ? 'unavailable' : 'ready',
      ...storeFailure === null ? {} : { storeError: storeFailure },
    }
  }

  /** 读取并解析 JSON 请求体，带字节上限。 */
  const readBody = async (req) => {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > bodyLimitBytes) {
        const error = new Error(`request body exceeds ${String(bodyLimitBytes)} bytes`)
        error.code = 'too-large'
        throw error
      }
      chunks.push(chunk)
    }
    if (size === 0) return {}
    let parsed
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      const error = new Error('request body is not valid JSON')
      error.code = 'bad-json'
      throw error
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      const error = new Error('request body must be a JSON object')
      error.code = 'bad-json'
      throw error
    }
    return parsed
  }

  const handleRequest = async (req, res) => {
    const connection = ctx.get('connection')
    if (connection !== undefined) {
      let admission
      try {
        admission = connection.admit({ headers: req.headers })
      } catch (error) {
        return send(res, 500, fail('admission-failed', error instanceof Error ? error.message : String(error)))
      }
      if (admission !== undefined && 'rejection' in admission) {
        return send(res, admission.rejection, fail('unauthorized', 'connection refused this request'))
      }
    }

    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      return send(res, 405, fail('method-not-allowed', 'this endpoint accepts POST'))
    }

    let body
    try {
      body = await readBody(req)
    } catch (error) {
      const tooLarge = error.code === 'too-large'
      return send(res, tooLarge ? 413 : 400, fail(tooLarge ? 'too-large' : 'bad-request', error instanceof Error ? error.message : String(error)))
    }

    const action = body.action
    const sessionId = body.sessionId
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
      return send(res, 400, fail('bad-session', 'sessionId must be a session identifier'))
    }

    await storeReady

    if (action === 'read') {
      return send(res, 200, { ok: true, state: stateOf(sessionId) })
    }

    if (table === null) {
      return send(res, 503, fail('store-unavailable', storeFailure ?? 'the per-conversation store is not open'))
    }

    if (action === 'save') {
      const text = body.text
      if (typeof text !== 'string') {
        return send(res, 400, fail('bad-text', 'text must be a string'))
      }
      if (text.length > maxPromptChars) {
        return send(res, 413, fail('too-long', `text exceeds ${String(maxPromptChars)} characters`))
      }
      // 空内容等价于「恢复默认」：不留下一条空记录。
      if (text.trim() === '') {
        try {
          await table.delete(sessionId)
        } catch (error) {
          return send(res, 500, fail('save-failed', error instanceof Error ? error.message : String(error)))
        }
        custom.delete(sessionId)
        return send(res, 200, { ok: true, state: stateOf(sessionId) })
      }
      const record = { text, updatedAt: Date.now() }
      try {
        // 先落盘、再改内存：写失败时内存与磁盘都不会偏离。
        await table.put(sessionId, record)
      } catch (error) {
        return send(res, 500, fail('save-failed', error instanceof Error ? error.message : String(error)))
      }
      custom.set(sessionId, record)
      return send(res, 200, { ok: true, state: stateOf(sessionId) })
    }

    if (action === 'reset') {
      try {
        await table.delete(sessionId)
      } catch (error) {
        return send(res, 500, fail('save-failed', error instanceof Error ? error.message : String(error)))
      }
      custom.delete(sessionId)
      return send(res, 200, { ok: true, state: stateOf(sessionId) })
    }

    return send(res, 400, fail('unknown-action', `unsupported action ${JSON.stringify(String(action))}`))
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: routePath,
    handler: handleRequest,
  }), 'tavern-system-prompt: editor route')
}
