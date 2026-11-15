/**
 * nissi-brand —— 宿主半区。
 *
 * 空的 `apply`：这一行存在的意义只是让 Loader 有一个宿主侧的行，
 * 真正的东西全在浏览器半区（`exports["./client"]` → `lib/client.js`）。
 * 与 `@deepseek-ai/dsh-client-ui-brand-official` 同构 —— 我们要顶掉它，
 * 就必须提供同形状的两半，否则组合里换不上去。
 */

/** 宿主插件体：本包只贡献浏览器端的呈现。 */
export function apply() {}
