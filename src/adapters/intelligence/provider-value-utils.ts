import type { ToolFactValue } from "../../domain/tools/index.js";

/**
 * 适配器层共享的值处理工具。
 *
 * 这里集中存放与具体协议/厂商无关的纯函数 helper，供 OpenAI Chat Completions、
 * OpenAI Responses、OpenAI-compatible Chat、模型 catalog 以及 fetch 桥接等适配器复用，
 * 避免同一份逻辑在多个文件里各自重定义。
 */

export function removeUndefinedValues(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function parseStructuredOutput(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

export function parseToolArguments(value: unknown): ToolFactValue {
  if (typeof value !== "string") {
    return (value ?? {}) as ToolFactValue;
  }
  try {
    return JSON.parse(value) as ToolFactValue;
  } catch {
    return { rawArguments: value };
  }
}

/**
 * 记录判定与规整统一由 `src/kernel/values/` 提供，这里转出以保持既有 import 路径稳定。
 */
export {
  asRecord,
  isPlainRecord,
  numberOrUndefined,
  stringOrUndefined,
} from "../../kernel/values/index.js";
