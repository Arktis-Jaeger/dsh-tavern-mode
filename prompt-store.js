/**
 * 酒馆模式自定义 System Prompt 的持久化声明。
 *
 * 数据形态归属：每个会话一条记录（`layout: 'per-record'`），键为 SessionId。
 * 这让「退出、切换或重新打开某段对话后恢复它自己的提示词」成为存储层的直接
 * 语义，而不是插件自己维护的旁路文件。
 *
 * 之所以能 import 随 dsh 出货的包：profile 里的本包是 `link:` 进来的「linked
 * package」，Node 从它的位置解析不到 DSH 安装目录；`dsh-app-boot` 的解析拦截层
 * 只在**本包 `peerDependencies` 声明了该名字**时才把请求路由到安装目录
 * （见 `routeLinked` 与 `profileDependencyNames`）。所以 `package.json` 里把
 * `@deepseek-ai/dsh-storage-domain` 列成 peer，而不是 dependency —— 出货包由 dsh
 * 安装提供，不需要（也不应该）再装一份。
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** 存储域与表名都必须匹配 `dsh-storage` 导出的 `UNIT_NAME_RE`。 */
export const PROMPT_DOMAIN_NAME = 'tavern_prompt'
export const PROMPT_TABLE_NAME = 'prompts'

/**
 * 一条持久化记录：该对话的自定义 System Prompt。
 *
 * 存储域只调用 `valueSchema.parse(raw)` 校验已存记录（域打开时逐条校验），
 * 因此这里给一个自包含的校验器即可 —— 一条字符串记录不值得再引入 schema 库。
 */
const promptRecord = {
  parse(raw) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('tavern_prompt record must be an object')
    }
    if (typeof raw.text !== 'string') {
      throw new Error('tavern_prompt record.text must be a string')
    }
    return {
      text: raw.text,
      updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    }
  },
}

export const promptDomainSpec = defineDomain({
  name: PROMPT_DOMAIN_NAME,
  version: 1,
  layout: 'per-record',
  // 单条记录损坏时备份并跳过，而不是让整个域打不开。
  invalidRecords: 'backup-and-skip',
  tables: { [PROMPT_TABLE_NAME]: domainTable(promptRecord) },
})
