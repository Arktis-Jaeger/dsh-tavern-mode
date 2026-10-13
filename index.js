/**
 * 酒馆模式 bundle 的根条目。
 *
 * Host 半边是空实现，它的存在有一个明确原因：`@deepseek-ai/dsh-client-modules`
 * 只扫描 Loader 的**根条目树**，而 `@deepseek-ai/dsh-agent-preset` 的预设子树
 * 会刻意从该树上解绑（`PresetTree` 复原了 owner 的 subtree/subgroup）。因此
 * 只挂在预设里的包，其 `dsh.client` 永远不会进入浏览器的模块表。这个根条目把
 * 包名暴露给扫描器，浏览器的 `./client` bundle 才会被提供。
 *
 * 真正的 Host 逻辑在 `./agent.js`，它作为预设的子插件挂载，只在「酒馆模式」
 * 预设作用域内生效。
 */

/** Cordis 插件名。 */
export const name = 'tavern-mode'

/** 不注册任何资源：本条目只为客户端模块表提供一个根 Loader 来源。 */
export function apply() {}
