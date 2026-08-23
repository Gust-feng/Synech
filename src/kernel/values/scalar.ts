/**
 * 标量取值与规整的唯一事实源。
 *
 * 收敛前 `stringOrUndefined` 在全仓有 18 处独立实现，且分裂为三种语义：
 * 过滤空白串并返回 trim 后的值、过滤空白串但返回原值、完全不过滤。
 * 同名不同行为会让调用方按名称推断语义时出错，这里按行为拆成显式命名的函数。
 */

/**
 * 取字符串值，并按“空白等同缺失”处理：非字符串或纯空白返回 `undefined`，否则返回 trim 后的值。
 *
 * 这是解析外部输入（协议字段、配置、模型输出）的默认选择。
 * 若必须保留原始首尾空白（例如正文片段、代码内容），改用 `rawStringOrUndefined`。
 */
export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * 取字符串值并保留原始首尾空白：非字符串或纯空白返回 `undefined`，否则原样返回。
 *
 * 用于空白本身携带语义的场景，例如流式正文分片、需要拼接的展示文案。
 */
export function rawStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** 判断值是否为字符串。 */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** 取有限数值；非数值、`NaN` 与 `Infinity` 返回 `undefined`。 */
export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 取布尔值；非布尔返回 `undefined`，不做 truthy 推断。 */
export function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** 取非负整数（含 0）；不满足返回 `undefined`。 */
export function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** 取正整数（不含 0）；不满足返回 `undefined`。 */
export function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
