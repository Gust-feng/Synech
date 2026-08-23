/**
 * 深拷贝的唯一事实源。
 *
 * 收敛前全仓并存两种克隆：103 处 `structuredClone` 与 11 处
 * `JSON.parse(JSON.stringify(...))`（其中 4 处封装为 `cloneJson`）。
 * JSON 往返会静默丢弃 `undefined` 值、把 `Date` 降级为字符串、丢失 `Map` / `Set`，
 * 并在循环引用时抛错。Node 22 下 `structuredClone` 为全局可用，无理由保留 JSON 版本。
 */

/** 深拷贝任意结构化可克隆值，保留 `Date`、`Map`、`Set` 与循环引用。 */
export function cloneDeep<T>(value: T): T {
  return globalThis.structuredClone(value);
}

/**
 * 把值投影成它被持久化为 JSON 后再读回来的形状。
 *
 * 这不是通用深拷贝，只用于持久化边界：仓储的 `save()` 需要保证自己的返回值与后续
 * `get()` 从磁盘读回的结果严格相等。JSON 往返会丢弃值为 `undefined` 的键、把 `Date`
 * 降级为字符串、丢失 `Map` / `Set`——在持久化边界上这些正是磁盘真实语义，所以此处
 * 的「有损」是刻意且必要的。
 *
 * 除持久化边界外一律使用 `cloneDeep`；把本函数当作通用克隆会静默丢失数据。
 */
export function toPersistedJsonShape<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
