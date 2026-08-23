import { stringOrUndefined } from "./scalar.js";

/**
 * 字符串集合规整的唯一事实源。
 *
 * 收敛前 `uniqueStrings` 有 9 处实现，`stringArray` 有 8 处，且行为并不一致：
 * 有的仅去重，有的去重并过滤空白，有的还会 trim；`stringArray` 则分裂为
 * 失败返回 `[]` 与失败返回 `undefined` 两种。这里不强行合并成一个函数，
 * 而是把每种真实存在的语义拆成显式命名，避免调用点按名称误判行为。
 */

/**
 * 按原值去重，保留首次出现顺序，不做 trim 也不过滤空白串。
 *
 * 用于值本身已规范化、只需消除重复的场景（例如已校验过的 ID 列表）。
 */
export function uniqueValues(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/**
 * 先按 `stringOrUndefined` 规整（trim 并丢弃空白串），再去重，保留首次出现顺序。
 *
 * 用于解析外部输入的字符串列表，是处理未经校验来源的默认选择。
 */
export function uniqueNonBlankStrings(values: readonly unknown[]): readonly string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = stringOrUndefined(value);
    if (normalized !== undefined) {
      seen.add(normalized);
    }
  }
  return [...seen];
}

/**
 * 把任意值解析为字符串数组；非数组或含非字符串元素时返回 `undefined`。
 *
 * 严格校验，用于必须拒绝畸形输入的协议/配置解析。
 */
export function stringArrayOrUndefined(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

/**
 * 把任意值宽松解析为字符串数组：非数组返回 `[]`，数组内非字符串与空白项被丢弃且元素被 trim。
 *
 * 用于“畸形输入等价于空列表”的容错解析场景。
 */
export function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    const normalized = stringOrUndefined(item);
    if (normalized !== undefined) {
      result.push(normalized);
    }
  }
  return result;
}
