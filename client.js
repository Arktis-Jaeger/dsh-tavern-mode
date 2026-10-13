/**
 * 酒馆模式的浏览器半边：Agent 预设选择栏最右侧的「自定义 System Prompt」入口，
 * 以及一个可以编写长文本的编辑器。
 *
 * 两个挂载点都落在**与 Agent 预设选择同一行**的位置，且都不遮蔽任何内置 UI：
 *  - `conversation.session.header.utilities`（list）：会话头部那一行的最右端。
 *    内置的 Agent 预设标签在 `conversation.session.header.actions`（`id: agent-preset`），
 *    两者同处一个横向 flex 行；`titleCluster` 是 `flex: 1`，把 utilities 挤到整行最右。
 *  - `conversation.input.dock`（list）：新建对话页面。预设选择所在的那一行是
 *    `conversation.hero.agentPreset` 这个 single 槽（登记即遮蔽内置选择器），行内没有
 *    追加型座位，因此用一个零高度占位项 + 绝对定位把芯片叠到该行最右侧，
 *    只在空白会话渲染以避免与头部座位重复。
 *
 * 两个挂载点都只在当前对话确实绑定到 `tavern` 预设时才渲染，
 * 因此不会影响其他 Agent 预设。
 *
 * 读写走 Host 在 `ctx.webServer` 上注册的精确路由；浏览器会话 cookie 是同源
 * HttpOnly，Host 侧再用 `ctx.connection.admit()` 做 Host/Origin 与会话校验。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-tavern-mode',
  factory(require) {
    const React = require('react')
    let createPortal
    try {
      createPortal = require('react-dom').createPortal
    } catch {
      createPortal = undefined
    }
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** 与 `cordis.patch.yml` 中 `tavern-system-prompt` 行的配置保持一致。 */
    const ROUTE = '/tavern-mode/system-prompt'
    const PRESET_ID = 'tavern'
    const NS = 'tavernSystemPrompt'

    const zh = {
      trigger: '自定义 System Prompt',
      triggerHint: '查看并修改本段对话的系统提示词（仅对本对话生效）',
      badgeCustom: '已自定义',
      badgeDefault: '默认',
      title: '自定义 System Prompt',
      subtitle: '只对当前这段对话生效。不会修改「酒馆模式」的预设默认值，也不影响其他对话。',
      loading: '读取中…',
      loadFailed: '读取失败',
      saveFailed: '保存失败',
      saved: '已保存',
      reset: '恢复默认',
      resetDone: '已恢复为预设默认值',
      cancel: '取消',
      save: '保存',
      close: '关闭',
      chars: '{count} 字符',
      emptyHint: '清空内容后保存，等同于恢复预设默认值。',
    }
    const en = {
      trigger: 'Custom System Prompt',
      triggerHint: 'View and edit this conversation\u2019s system prompt (this conversation only)',
      badgeCustom: 'Custom',
      badgeDefault: 'Default',
      title: 'Custom System Prompt',
      subtitle: 'Applies to this conversation only. The Tavern Mode preset default and every other conversation stay untouched.',
      loading: 'Loading\u2026',
      loadFailed: 'Could not load',
      saveFailed: 'Could not save',
      saved: 'Saved',
      reset: 'Restore default',
      resetDone: 'Restored the preset default',
      cancel: 'Cancel',
      save: 'Save',
      close: 'Close',
      chars: '{count} characters',
      emptyHint: 'Saving an empty editor restores the preset default.',
    }

    const describe = (error) => (error instanceof Error ? error.message : String(error))

    // ── 传输层 ────────────────────────────────────────────────────────────
    /** 一次 Host 往返；失败抛错并带上 Host 给出的原因。 */
    const callHost = async (payload) => {
      let response
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } catch (error) {
        throw new Error(`网络请求失败：${describe(error)}`)
      }
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`HTTP ${String(response.status)}`)
      }
      if (body !== null && typeof body === 'object' && body.ok === true) return body.state
      const detail = body !== null && typeof body === 'object' && body.error !== undefined
        ? `${String(body.error.code)}: ${String(body.error.message)}`
        : `HTTP ${String(response.status)}`
      throw new Error(detail)
    }

    // ── 共享状态：一处读取，两个挂载点共用 ────────────────────────────────
    /** sessionId -> { status, state, error, notice } */
    const entries = new Map()
    const listeners = new Set()
    const EMPTY = { status: 'idle', state: null, error: null, notice: null }

    const entryOf = (sessionId) => entries.get(sessionId) ?? EMPTY
    const publish = (sessionId, next) => {
      entries.set(sessionId, next)
      for (const listener of listeners) listener(sessionId, next)
    }
    const subscribe = (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    const load = async (sessionId) => {
      const current = entryOf(sessionId)
      if (current.status === 'loading' || current.status === 'ready' || current.status === 'saving') return
      publish(sessionId, { ...current, status: 'loading', error: null })
      try {
        const state = await callHost({ action: 'read', sessionId })
        publish(sessionId, { status: 'ready', state, error: null, notice: null })
      } catch (error) {
        publish(sessionId, { ...entryOf(sessionId), status: 'error', error: describe(error) })
      }
    }

    const mutate = async (sessionId, action, text) => {
      publish(sessionId, { ...entryOf(sessionId), status: 'saving', error: null })
      try {
        const state = await callHost({ action, sessionId, ...(text === undefined ? {} : { text }) })
        const cleared = action === 'reset' || (typeof text === 'string' && text.trim() === '')
        publish(sessionId, { status: 'ready', state, error: null, notice: cleared ? 'resetDone' : 'saved' })
        return { ok: true, state }
      } catch (error) {
        publish(sessionId, { ...entryOf(sessionId), status: 'ready', error: describe(error) })
        return { ok: false, error: describe(error) }
      }
    }

    /** 订阅一个会话的条目。 */
    function useEntry(sessionId) {
      const [entry, setEntry] = useState(() => entryOf(sessionId))
      useEffect(() => {
        setEntry(entryOf(sessionId))
        return subscribe((changed, next) => {
          if (changed === sessionId) setEntry(next)
        })
      }, [sessionId])
      return entry
    }

    // ── 预设门禁 ─────────────────────────────────────────────────────────
    /** 全页只读一次预设名册，用于「预设尚未提交到该空白会话」这一瞬态。 */
    let rosterPromise
    const rosterDefaultId = (remote, serviceLookup) => {
      if (rosterPromise !== undefined) return rosterPromise
      rosterPromise = (async () => {
        try {
          const namespace = remote?.agentPresets ?? serviceLookup('remote.agentPresets')
          if (namespace === undefined || namespace === null || typeof namespace.list !== 'function') return undefined
          const result = await namespace.list()
          if (result === undefined || result === null || result.ok !== true) return undefined
          const presets = result.value?.presets ?? []
          const preferred = presets.find((row) => row.isDefault === true) ?? presets.find((row) => row.id === PRESET_ID)
          return preferred?.id
        } catch {
          return undefined
        }
      })()
      return rosterPromise
    }

    /** 该会话是否属于酒馆模式；`blank` 用于让两个挂载点互不重叠。 */
    function useGate(useSessions, sessionId, remoteOf, serviceLookup) {
      const summary = useSessions((state) => (sessionId === undefined ? undefined : state.byId[sessionId]))
      const preset = summary?.projectionValues?.agentPreset ?? null
      const blank = summary?.blank === true
      const [rosterDefault, setRosterDefault] = useState(undefined)
      useEffect(() => {
        if (preset === PRESET_ID || preset !== null || !blank) return undefined
        let alive = true
        rosterDefaultId(remoteOf(), serviceLookup).then((id) => {
          if (alive) setRosterDefault(id)
        })
        return () => {
          alive = false
        }
      }, [preset, blank, remoteOf, serviceLookup])
      const visible = preset === PRESET_ID || (preset === null && blank && rosterDefault === PRESET_ID)
      return { visible, blank }
    }

    // ── 样式（只使用宿主主题 token；由组件渲染，卸载即消失） ──────────────
    const CSS = `
.tvrn_chip{display:inline-flex;align-items:center;gap:6px;height:28px;max-width:260px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.tvrn_chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.tvrn_chip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.tvrn_chipLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tvrn_chipBadge{flex:none;padding:0 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}
.tvrn_chipBadge[data-on=true]{background:var(--dsw-alias-state-business-primary);color:#fff}
.tvrn_headerSeat{display:inline-flex;align-items:center}
/* 新建对话页面：把入口叠到「工作区 / Agent 预设选择」那一行的最右侧。
   conversation.hero.agentPreset 是 single 槽（登记即遮蔽内置选择器），那一行没有
   追加型座位，所以这里用一个零高度占位项 + 绝对定位把芯片对齐过去。
   占位项紧跟该行之后，bottom: calc(100% + 8px) 正好回到该行底边
   （hero 模式的 composerHero 把 stack gap 设为 8px）。芯片与内置预设芯片同为
   28px 高，因此底边对齐即整行对齐；绝对定位不参与布局，不会推挤或覆盖同行控件。 */
.tvrn_heroSeat{position:relative;height:0;min-height:0;flex:none}
.tvrn_heroChip{position:absolute;right:var(--dsh-composer-side-clearance,16px);bottom:calc(100% + 8px);z-index:2;max-width:min(240px,45vw);background:var(--dsw-alias-bg-base)}
.tvrn_root{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}
.tvrn_mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}
.tvrn_dialog{position:relative;display:flex;flex-direction:column;width:min(720px,100%);max-height:min(86vh,900px);border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);overflow:hidden}
.tvrn_header{display:flex;align-items:flex-start;gap:12px;padding:20px 16px 12px 24px}
.tvrn_headerText{flex:1;min-width:0}
.tvrn_title{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;line-height:24px;font-weight:500}
.tvrn_subtitle{margin:6px 0 0;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}
.tvrn_close{flex:none;width:28px;height:28px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;cursor:pointer}
.tvrn_close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tvrn_body{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px;padding:0 24px}
.tvrn_editor{box-sizing:border-box;width:100%;min-height:min(52vh,520px);max-height:min(60vh,560px);resize:vertical;padding:12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:1.6;white-space:pre-wrap;overflow:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.tvrn_editor:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.tvrn_meta{display:flex;align-items:flex-start;gap:12px;color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}
.tvrn_status{margin-left:auto;text-align:right;max-width:60%;word-break:break-word}
.tvrn_status[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.tvrn_status[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}
.tvrn_footer{display:flex;align-items:center;gap:8px;padding:16px 24px 20px}
.tvrn_spacer{flex:1}
.tvrn_button{height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}
.tvrn_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.tvrn_button:disabled{opacity:.45;cursor:default}
.tvrn_button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.tvrn_primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-state-business-primary));color:#fff}
.tvrn_primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-state-business-primary))}
`

    /** 组件局部样式；随组件一起卸载。 */
    function Styles() {
      return h('style', { 'data-plugin-css': '@local/dsh-tavern-mode/editor' }, CSS)
    }

    /** 与宿主图标同级的极简提示词图标。 */
    function IconPrompt(props) {
      const size = props === undefined || props === null || props.size === undefined ? 14 : props.size
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': true,
        style: { flex: 'none' },
      },
        h('path', {
          d: 'M3 2.5h7.5A2.5 2.5 0 0 1 13 5v6a2.5 2.5 0 0 1-2.5 2.5H6.2L3.4 15.4A.6.6 0 0 1 2.4 15V2.5Z',
          stroke: 'currentColor',
          strokeWidth: '1.3',
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M5.2 5.4h5.6M5.2 7.6h5.6M5.2 9.8h3.4', stroke: 'currentColor', strokeWidth: '1.1', strokeLinecap: 'round' }),
      )
    }

    /** 编辑器对话框。 */
    function Editor(props) {
      const { sessionId, entry, t, onClose } = props
      const state = entry.state
      const [draft, setDraft] = useState(state === null ? '' : state.effective)
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(null)
      const textarea = useRef(null)

      useEffect(() => {
        if (textarea.current !== null) textarea.current.focus()
      }, [])

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented) return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [onClose])

      const settle = (outcome) => {
        setBusy(false)
        if (outcome.ok) onClose()
        else setFailure(outcome.error)
      }
      const save = () => {
        setBusy(true)
        setFailure(null)
        mutate(sessionId, 'save', draft).then(settle)
      }
      const reset = () => {
        setBusy(true)
        setFailure(null)
        mutate(sessionId, 'reset').then(settle)
      }

      const storeBroken = state !== null && state !== undefined && state.store !== 'ready'
      const tone = failure !== null ? 'error' : storeBroken ? 'warn' : 'ok'
      const statusText = failure !== null
        ? `${t('saveFailed')}: ${failure}`
        : storeBroken
          ? `${t('loadFailed')}: ${state.storeError ?? 'store unavailable'}`
          : t('emptyHint')

      const dialog = h('div', {
        className: 'tvrn_root',
        role: 'presentation',
        onKeyDownCapture: (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onClose()
        },
      },
        h('div', { className: 'tvrn_mask', 'aria-hidden': true, onClick: onClose }),
        h('div', {
          className: 'tvrn_dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('title'),
          tabIndex: -1,
        },
          h('div', { className: 'tvrn_header' },
            h('div', { className: 'tvrn_headerText' },
              h('h2', { className: 'tvrn_title' }, t('title')),
              h('p', { className: 'tvrn_subtitle' }, t('subtitle')),
            ),
            h('button', { type: 'button', className: 'tvrn_close', 'aria-label': t('close'), onClick: onClose }, '\u00D7'),
          ),
          h('div', { className: 'tvrn_body' },
            h('textarea', {
              ref: textarea,
              className: 'tvrn_editor',
              value: draft,
              spellCheck: false,
              'aria-label': t('title'),
              onChange: (event) => {
                setDraft(event.target.value)
                setFailure(null)
              },
            }),
            h('div', { className: 'tvrn_meta' },
              h('span', null, t('chars', { count: draft.length.toLocaleString() })),
              h('span', { className: 'tvrn_status', 'data-tone': tone }, statusText),
            ),
          ),
          h('div', { className: 'tvrn_footer' },
            h('button', {
              type: 'button',
              className: 'tvrn_button',
              disabled: busy || (state === null ? true : state.custom === null),
              onClick: reset,
            }, t('reset')),
            h('span', { className: 'tvrn_spacer' }),
            h('button', { type: 'button', className: 'tvrn_button', disabled: busy, onClick: onClose }, t('cancel')),
            h('button', {
              type: 'button',
              className: 'tvrn_button tvrn_primary',
              disabled: busy,
              onClick: save,
            }, busy ? t('loading') : t('save')),
          ),
        ),
      )

      return createPortal === undefined ? dialog : createPortal(dialog, document.body)
    }

    /**
     * 预设选择栏旁边的入口。`variant` 决定它落在哪个追加槽里：
     * `header` 是会话头部（紧挨内置 Agent 预设标签），`dock` 是新建对话页面。
     */
    function SystemPromptControl(props) {
      const { sessionId, variant, t, remoteOf, serviceLookup, useSessions } = props
      const gate = useGate(useSessions, sessionId, remoteOf, serviceLookup)
      const entry = useEntry(sessionId)
      const [open, setOpen] = useState(false)
      const trigger = useRef(null)
      const visible = gate.visible && (variant !== 'dock' || gate.blank)

      useEffect(() => {
        if (!visible || sessionId === undefined) return
        load(sessionId)
      }, [visible, sessionId])

      const close = useCallback(() => {
        setOpen(false)
        const node = trigger.current
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus()
      }, [])

      if (!visible || sessionId === undefined) return null

      const state = entry.state
      const custom = state === null ? null : state.custom
      const busy = entry.status === 'loading' || entry.status === 'saving'
      const badge = entry.status === 'loading'
        ? t('loading')
        : entry.status === 'error'
          ? t('loadFailed')
          : custom === null
            ? t('badgeDefault')
            : t('badgeCustom')
      const hint = entry.status === 'error'
        ? `${t('loadFailed')}: ${entry.error}`
        : entry.notice !== null && entry.notice !== undefined
          ? t(entry.notice)
          : t('triggerHint')

      // `hero` 座位叠到新建对话页的预设选择行最右侧；`header` 座位直接排进
      // 会话头部同一行的最右端（`conversation.session.header.utilities`）。
      const hero = variant === 'hero'
      return h(React.Fragment, null,
        h(Styles, null),
        h('div', { className: hero ? 'tvrn_heroSeat' : 'tvrn_headerSeat' },
          h('button', {
            ref: trigger,
            type: 'button',
            className: hero ? 'tvrn_chip tvrn_heroChip' : 'tvrn_chip',
            title: hint,
            disabled: busy,
            onClick: () => {
              if (entry.status === 'error') load(sessionId)
              else setOpen(true)
            },
          },
            h(IconPrompt, { size: 14 }),
            h('span', { className: 'tvrn_chipLabel' }, t('trigger')),
            h('span', { className: 'tvrn_chipBadge', 'data-on': custom !== null }, badge),
          ),
        ),
        open && state !== null
          ? h(Editor, { sessionId, entry, t, onClose: close })
          : null,
      )
    }

    // ── 客户端插件 ────────────────────────────────────────────────────────
    const inject = ['slots', 'sessions', 'locale', 'remote', 'remote.agentPresets']

    function apply(ctx) {
      const serviceLookup = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)
      const remoteOf = () => ctx.remote
      const seatProps = { remoteOf, serviceLookup }

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tavern-system-prompt: locale')

      // 组件身份必须稳定：`ctx.slots.inject` 的回调可能重新执行，
      // 每次返回新函数会让槽位内容重新挂载。
      const HeaderSeat = (props) => h(SystemPromptControl, { ...props, ...seatProps, variant: 'header' })
      const HeroSeat = (props) => h(SystemPromptControl, { ...props, ...seatProps, variant: 'hero' })

      // 会话头部：`conversation.session.header.utilities` 与内置的 Agent 预设标签
      // （`conversation.session.header.actions` 里的 `id: agent-preset`）同处一个
      // 横向 flex 行 —— titleCluster 是 flex:1，把 utilities 挤到整行最右端。
      ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'tavern-system-prompt',
        order: 0,
        locale: NS,
      }, HeaderSeat)), 'tavern-system-prompt: header utilities seat')

      // 新建对话页面：该行没有追加型座位，HeroSeat 用零高度占位把芯片对齐到
      // 预设选择行最右侧（见 CSS 里的说明）。只在空白会话渲染，正常会话由头部座位接管。
      ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'tavern-system-prompt',
        order: 0,
        locale: NS,
      }, HeroSeat)), 'tavern-system-prompt: hero seat')
    }

    return { inject, apply }
  },
})
