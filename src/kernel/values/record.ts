/**
 * 记录对象判定与规整的唯一事实源。
 *
 * 收敛前全仓有 27 处各自重写的 `asRecord`，且失败返回值分裂为 `{}` 与 `undefined`
 * 两种互不兼容的语义，下游 `?.` / `??` 判空会走向不同分支。这里按语义拆成两个显式
 * 命名的函数，让调用点在“缺失可省略”与“缺失需区分”之间做出明确选择。
 */

/**
 * 判断值是否为普通记录对象：`typeof === "object"`、非 `null`、非数组。
 *
 * 是 `asRecord` 与 `asOptionalRecord` 的共同判定基准，确保全仓对“记录”的理解一致。
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把任意值规整为普通记录对象；非记录值统一返回空对象 `{}`。
 *
 * 适用于“字段缺失等价于空配置”的解析场景，可直接链式读取属性而无需判空。
 * 若调用点需要区分“本来就是空对象”与“根本不是对象”，改用 `asOptionalRecord`。
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}

/**
 * 把任意值规整为普通记录对象；非记录值返回 `undefined`。
 *
 * 适用于需要区分“缺失”与“空记录”的场景，例如可选协议字段、需要回退到默认值的配置节点。
 */
export function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined;
}
