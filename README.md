# 酒馆模式 · dsh-tavern-mode

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 增加一个**角色扮演 Agent 预设**，
以及一个**跟随单段对话保存的自定义 System Prompt 编辑器**。

> 预设自带默认角色扮演人设；每段对话可以拥有自己的 System Prompt，
> 只对该对话生效，切换、退出、重启后依然保留，且永不污染预设默认值或其他对话。

---

## 特性

- **Agent 预设「酒馆模式」**：默认 System Prompt 写在预设声明里，新建对话即生效。
- **与预设选择同一行的入口**：位于 Agent 预设选择栏的**最右侧**，不遮蔽任何内置控件。
- **对话级 System Prompt 编辑器**：长文本编辑框、字符计数、保存 / 取消 / 恢复默认、Escape 关闭。
- **严格隔离**：
  - 只对当前对话生效，不修改预设默认值；
  - 其他对话、其他 Agent 预设完全不受影响；
  - 清空内容保存即等于恢复默认。
- **真正进入模型请求**：作为提示词段落参与 `dsh-agent-loop` 的组装，而不是只存界面或配置。
- **落盘持久**：每个 SessionId 一条记录，进程重启后自动恢复。
- **零第三方依赖**：只通过 Cordis Service 与 DSH 出货包交互，不引入 npm 依赖。

## 环境要求

- DeepSeek Harness（`0.2.0-rc.2` 起，通过插件 `peerDependencies` 声明）
- 一个使用 **bundle patch** 的 profile（内置的 `web` / `desktop` profile 都满足）

## 安装

### 方式一：交给 DSH 的插件管理器（推荐）

```
plugin_manager install_bundle target=<本仓库的绝对路径>
```

它会自己跑 `pnpm add`、把本包以 `link:` 装进当前 profile，并把它追加到 `dsh.profile.bundles`。

### 方式二：命令行

```bash
dsh plugin --profile <profile> add <本仓库的绝对路径>
```

> 安装后请**重启一次 DeepSeek Harness**。
> Loader 使用 Node 的 ESM 加载器，模块按 URL 缓存且没有 cache-bust，
> 新增插件的 JavaScript 只有在新的进程里才会被加载。

## 使用

1. 新建对话，在 **Agent 预设选择栏**里选「**酒馆模式**」。
2. 该对话直接使用预设内置的默认角色扮演提示词。
3. 点击预设选择栏**最右侧**的「**自定义 System Prompt**」：
   - 打开编辑器，里面预填当前生效的提示词；
   - 修改后按「保存」→ 只有这段对话改变，标签变为「已自定义」；
   - 按「恢复默认」或清空内容后保存 → 回到预设默认值。
4. 新建另一段对话 → 它仍然使用预设默认值；切回原对话 → 自定义内容还在。

编辑框里的 `{{char}}`、`{{user}}` 等花括号会**原样保留**，不会被提示词变量插值当成引用。

## 工作原理

### 1. 默认值属于预设，而不是全局设置

预设由 `@deepseek-ai/dsh-agent-preset` 的一行声明而成，本插件的默认提示词就写在
该预设的子插件行上（`cordis.patch.yml` 里的 `config.defaultPrompt`），
因此它随预设一起被展示、一起生效，也只在这个预设里可见。

### 2. 对话级覆盖靠「更近作用域的提示词段落」

Host 半边监听 `agent/created`，为每一个绑定到 `tavern` 的 Agent 在它**自己的** `agent.ctx`
上注册 `deployment:persona-prefix` 段落：

```js
agent.ctx.effect(() => agent.ctx.systemPrompt.section({
  name: PERSONA_PREFIX_SECTION,          // 'deployment:persona-prefix' —— 共享契约名
  order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
  text: () => custom.get(agent.id)?.text ?? defaultPrompt,
  interpolate: false,
}))
```

`dsh-system-prompt` 的 `ScopedLayers.merge()` 从全局层开始、按「由远到近」叠加作用域链，
**最近的层赢得同名段落**。Agent 的 scope 是预设修订 scope 的子节点，因此这段注册遮蔽了
部署层与预设层的默认人设 —— 这正是 `dsh-system-prompt` 错误信息里指出的
「per-agent override，请通过 `agent.ctx` 注册」。

`text` 是函数，每次组装都重新求值，因此保存后下一步请求即生效，无需重新注册。
该段落最终由 `dsh-agent-loop` 的 `renderPrompt(assembly)` 渲染进模型请求。

### 3. 持久化：每段对话一条记录

```js
defineDomain({
  name: 'tavern_prompt', version: 1, layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { prompts: domainTable(recordSchema) },
})
```

- **键 = SessionId**，所以「退出 / 切换 / 重新打开某段对话」天然就是存储层的语义。
- `per-record` 布局让每次写入只重写该对话的一个文档。
- 域打开时把全部记录读进内存镜像，读取保持同步；**写入先落盘、再改内存**，
  写失败时内存与磁盘都不会偏离。
- 落盘位置：`$DSH_HOME/storages/tavern_prompt/prompts/<sessionId>.json`。

### 4. 浏览器半边

| 位置 | 槽 | 说明 |
|---|---|---|
| 会话头部 | `conversation.session.header.utilities`（append-only list） | 与内置的 Agent 预设标签同处一个横向 flex 行；`titleCluster` 是 `flex: 1`，把本槽挤到整行**最右端** |
| 新建对话页 | `conversation.input.dock`（append-only list） | 预设选择所在的那一行是 `conversation.hero.agentPreset` 这个 **single** 槽，行内没有追加型座位；这里用零高度占位项 + 绝对定位把芯片叠到该行**最右侧** |

两个入口都只在当前对话确实绑定到 `tavern` 时才渲染。点击后弹出 `role="dialog"` / `aria-modal="true"`
的浮层，样式只使用 `--dsw-alias-*` 主题 token，并随组件卸载移除。

### 5. 传输：Host 上的精确路由

Host 在 `ctx.webServer` 注册 `POST /tavern-mode/system-prompt`，请求体
`{ action: 'read' | 'save' | 'reset', sessionId, text? }`。
路由先调用 `ctx.connection.admit({ headers })` 做 Host/Origin 与浏览器会话校验，未通过直接 401/403。

之所以不用 `ctx.remote.*`：该命名空间由构建期固定，插件无法在运行时新增命名空间；
而 `host.call` 只提供给 `cordis_define` 创建的动态包。

## 关键设计决策

| 决策 | 理由 |
|---|---|
| 覆盖注册在 `agent.ctx`，而不是预设 scope | 预设 scope 已被默认人设占用，同层同名会抛错；只有更近的 scope 才会遮蔽。 |
| 段落 `interpolate: false` | `{{char}}` / `{{user}}` 是角色扮演提示词的常规写法，不能被当作变量引用。 |
| 空内容保存 == 恢复默认 | 满足「清除自定义内容即回到默认值」，且不留下空记录。 |
| 写入先落盘后改内存 | 保存失败时界面报错，内存镜像不偏离磁盘。 |
| `peerDependencies` 而非 `dependencies` | 以 `link:` 装进 profile 的 bundle 属于 *linked package*；`dsh-app-boot` 的解析拦截层只在 peer 名单里才把出货包路由回 DSH 安装目录。出货包由 DSH 提供，不需要也不应再装一份。 |
| 保留一个空实现的根行 | `PresetTree` 会把自己从 Loader 根条目树上解绑，只挂在预设里的包不会被 `dsh-client-modules` 扫描到，客户端半边就进不了页面。 |
| 预设默认值 `complete: false` | 只替换人设段落，Harness 身份与工具指引保留，Agent 依旧可用。 |
| 不遮蔽内置预设选择器 | `conversation.hero.agentPreset` 是 single 槽，登记即替换内置 UI；因此改用追加型座位 + 绝对定位。 |

## 实测验收

以下结果来自**隔离的临时 profile**（`dsh rescue --from-default-profile web` + 本插件，
独立进程与端口）。`assemble` 返回的是 `dsh-agent-loop` 渲染进模型请求的同一份 `PromptAssembly`。

| # | 场景 | 结果 |
|---|---|---|
| 1 | 酒馆模式新建对话 A | `composedPreset = tavern`；`deployment:persona-prefix` = 预设默认值（438 字符），`interpolate: false` |
| 2 | 修改 A 的 System Prompt | 保存后再组装，该段落变为自定义文本；`{{char}}` / `{{user}}` 原样保留 |
| 3 | 新建对话 B | B 仍为预设默认值 |
| 4 | A/B 反复切换（各 3 次） | A 始终自定义、B 始终默认，互不干扰 |
| 5 | 关闭并重新打开 A | 进程重启后 `read` 即恢复自定义值；重新挂载 A 后组装出的仍是自定义文本 |
| 6 | 恢复 A 的默认 | A 回到默认；同时持有自定义文本的 B 未变；预设默认值未变；新建对话仍拿到默认值 |
| 7 | 切到其他 Agent 预设 | `standard` 预设的会话拿到 standard 的人设，未被触碰 |
| 8 | 热加载 | 运行中向 profile patch 新增一个预设，无需重启即出现在实时名册；本插件路由保持可用、对话数据不丢 |
| 9 | 保存失败 | 存储目录设为只读后保存 → `500 {"code":"save-failed","message":"EACCES …"}`；随后 `read` 仍为 `custom: null`（内存未偏离磁盘）；目录恢复可写后保存成功 |
| 10 | 异常与边界 | 非 JSON → 400 `bad-request`；未知 action → 400 `unknown-action`；非法 sessionId → 400 `bad-session`；超长文本 → 413 `too-long`；GET → 405 `method-not-allowed`；无会话 cookie → 401 `unauthorized` |
| 11 | 客户端半边 | 页面启动载荷包含 `{"id":"@local/dsh-tavern-mode","url":"plugins/??@local/dsh-tavern-mode/client.js&rev=…"}`，bundle 可 200 取回且含两个座位与样式标记 |

**未执行**：浏览器内的视觉验证。本机没有浏览器控制通道，客户端的加载、槽位注册与样式内容是
通过启动载荷与 bundle 内容确认的，**没有**做过截图或像素级确认。

## 已知限制

1. **改动本插件的 JavaScript 需要重启 DSH。** Loader 走 Node 的 ESM 加载器，模块按 URL 缓存且没有
   cache-bust，`package.json` 的 `exports` 也在进程内被缓存。首次安装后如果又改了 `*.js` 或
   `exports`，必须重启一次才会加载新的模块代际。
2. **新建对话页的入口用绝对定位对齐。** 预设选择行（`conversation.hero.agentPreset`）是 `single` 槽，
   行内没有追加型座位；本插件用零高度占位项 + `bottom: calc(100% + 8px)` 把芯片叠到该行最右侧，
   依赖 hero 模式 8px 的行间距与两枚芯片同为 28px 高。若上游改动该行高度/间距，需要同步调整
   `client.js` 中的 `.tvrn_heroSeat` / `.tvrn_heroChip`。彻底的解法是让上游在该行新增一个 list 槽。
3. **自定义提示词是一个提示词段落，而不是整份 System Prompt。** 若要后者，把 `cordis.patch.yml` 里
   `tavern-system-prompt` 行的 `config` 加上 `complete: true`（会同时抑制身份与工具指引段落）。

## 卸载

```
plugin_manager remove_bundle target=@local/dsh-tavern-mode
# 可选：清掉该预设留下的对话级数据
rm -rf ~/.dsh/storages/tavern_prompt
```

移除 bundle 会同时移除预设声明行与根行，不影响其他 bundle、其他 Agent 预设或既有会话记录。

## 仓库结构

```
.
├── package.json        # bundle 清单、dsh.client、出货包 peerDependencies
├── cordis.patch.yml    # 插入 preset-tavern 与 tavern-mode 两行（不覆盖任何已有行）
├── index.js            # 空实现的根行：让 dsh.client 进入浏览器模块表
├── host.js             # Host 半边：per-agent 提示词段落 + 编辑器读写路由
├── prompt-store.js     # tavern_prompt 存储域声明（per-record，键 = SessionId）
├── client.js           # 浏览器半边：两个挂载点 + 长文本编辑器浮层
├── locale/{zh,en}.json # 插件管理页展示文案
└── icon.svg            # 插件图标
```

## 许可

MIT，见 [LICENSE](LICENSE)。
