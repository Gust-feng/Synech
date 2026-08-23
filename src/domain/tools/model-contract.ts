import type {
  ToolCategory,
  ToolDefinition,
  ToolFileDisplayOperation,
  ToolOperationType,
  ToolRiskLevel,
} from "./contracts.js";
import { cloneToolInputSchema, cloneToolJsonSchema } from "./schema.js";

export type ModelVisibleToolContractValidation = {
  readonly ok: boolean;
  readonly missing: readonly string[];
};

export const MODEL_VISIBLE_TOOL_DESCRIPTION_MAX_CHARS = 512;

export type ModelVisibleToolDescriptionOptions = {
  readonly maxChars?: number;
};

/**
 * 生成 provider function/tool 的描述正文。
 *
 * Provider 已独立接收输入 schema；模型只需要工具的客观能力摘要。运行时策略、确认、
 * provider 协议、存储和展示细节不属于工具选择信息，不能拼接进模型上下文。
 *
 * 跨字段约束应优先进入 schema，动态 continuation 以实际工具结果表达。
 */
export function modelVisibleToolDescription(
  definition: ToolDefinition,
  options: ModelVisibleToolDescriptionOptions = {}
): string {
  const maxChars = normalizedDescriptionBudget(options.maxChars);
  return fitDescriptionBudget(definition.description.trim(), maxChars);
}

/**
 * 工具「进模型可见集合」的统一事实门槛（FR-TOOL-001 / FR-TOOL-002）。
 *
 * 模型可见工具只必须具备可执行 identity、客观 description、有效 input schema 以及
 * 执行/副作用元数据。`ToolRegistry.register` 只对真实 `ToolExecutor` 调用本校验；执行结果
 * 另由 ToolCenter 归一化为 `ToolCallResult`，截断时必须在输出顶层提供真实
 * `continuation / continuations`。这些运行时事实不能用一段 `outputNotes` 散文伪装成静态校验。
 *
 */
export function validateModelVisibleToolContract(
  definition: ToolDefinition
): ModelVisibleToolContractValidation {
  const missing: string[] = [];
  if (!hasText(definition.name)) {
    missing.push("name");
  }
  if (!hasText(definition.description)) {
    missing.push("description");
  }
  try {
    cloneToolInputSchema(definition.inputSchema);
  } catch {
    missing.push("inputSchema");
  }
  if (definition.outputSchema !== undefined) {
    try {
      cloneToolJsonSchema(definition.outputSchema);
    } catch {
      missing.push("outputSchema");
    }
  }
  const metadata = definition.metadata;
  if (metadata === undefined) {
    missing.push("metadata");
  } else {
    if (!isToolCategory(metadata.category)) {
      missing.push("metadata.category");
    }
    if (!isRiskLevel(metadata.riskLevel)) {
      missing.push("metadata.riskLevel");
    }
    if (!isOperationType(metadata.operationType)) {
      missing.push("metadata.operationType");
    }
    if (typeof metadata.requiresConfirmation !== "boolean") {
      missing.push("metadata.requiresConfirmation");
    }
    if (metadata.fileOperation !== undefined && !isFileOperation(metadata.fileOperation)) {
      missing.push("metadata.fileOperation");
    }
  }
  return {
    ok: missing.length === 0,
    missing,
  };
}

/**
 * 解析工具的有效确认要求，应用保守默认（FR-TOOL-002：「缺确认策略时默认按需确认」）。
 *
 * 显式契约字段 `requiresConfirmation` 是权威来源。当其缺失（例如经松散运行时数据
 * 绕过完备门槛的兼容/MCP 路径）时，对高影响动作（execute / external-submit / delete /
 * high risk）默认按需确认，确保不会因契约字段缺失而静默执行高影响动作。
 *
 * 参数为结构化类型，可同时接受 `ToolDefinitionMetadata` 与能力快照中的工具条目。
 */
export function resolveEffectiveConfirmationRequirement(
  metadata:
    | {
        readonly requiresConfirmation?: boolean;
        readonly operationType?: ToolOperationType;
        readonly fileOperation?: ToolFileDisplayOperation;
        readonly riskLevel?: ToolRiskLevel;
      }
    | undefined
): boolean {
  if (metadata?.requiresConfirmation !== undefined) {
    return metadata.requiresConfirmation;
  }
  if (metadata === undefined) {
    return true;
  }
  if (
    metadata.operationType === "execute" ||
    metadata.operationType === "external-submit"
  ) {
    return true;
  }
  if (metadata.fileOperation === "delete") {
    return true;
  }
  if (metadata.riskLevel === "high") {
    return true;
  }
  return false;
}

function isToolCategory(value: unknown): value is ToolCategory {
  return (
    value === "research" ||
    value === "workspace" ||
    value === "filesystem" ||
    value === "terminal" ||
    value === "web" ||
    value === "mcp" ||
    value === "other"
  );
}

function isRiskLevel(value: unknown): value is ToolRiskLevel {
  return value === "low" || value === "medium" || value === "high";
}

function isOperationType(value: unknown): value is ToolOperationType {
  return (
    value === "read-only" ||
    value === "read-write" ||
    value === "execute" ||
    value === "external-submit"
  );
}

function isFileOperation(value: unknown): value is ToolFileDisplayOperation {
  return (
    value === "create" ||
    value === "write" ||
    value === "append" ||
    value === "edit" ||
    value === "delete"
  );
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizedDescriptionBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return MODEL_VISIBLE_TOOL_DESCRIPTION_MAX_CHARS;
  }
  return Math.max(1, Math.floor(value));
}

function fitDescriptionBudget(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const marker = " …[truncated]";
  if (marker.length >= maxChars) {
    return value.slice(0, maxChars);
  }
  const bodyLimit = maxChars - marker.length;
  const candidate = value.slice(0, bodyLimit);
  const completeBoundary = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(".") + 1);
  const wordBoundary = candidate.lastIndexOf(" ");
  const cutoff = completeBoundary >= Math.floor(bodyLimit / 2)
    ? completeBoundary
    : wordBoundary > 0
      ? wordBoundary
      : bodyLimit;
  return `${candidate.slice(0, cutoff).trimEnd()}${marker}`;
}
