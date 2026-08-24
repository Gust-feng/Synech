import type { ConfirmationRequest } from "../confirmation/contracts.js";
import type { ModelInputAttachmentRef } from "../model-input/index.js";
import type { ToolFactValue } from "./fact-value.js";
import type { ToolJsonSchema, ToolJsonSchemaValue } from "./schema.js";

export type ToolInputSchema = {
  readonly type: "object";
  readonly properties: Record<string, ToolJsonSchemaValue>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | ToolJsonSchema;
  /** Preserve JSON Schema keywords not interpreted by the host. */
  readonly [keyword: string]: unknown;
};

export type ToolCategory = "research" | "workspace" | "filesystem" | "terminal" | "web" | "mcp" | "other";

export type ToolRiskLevel = "low" | "medium" | "high";

export type ToolOperationType =
  | "read-only"
  | "read-write"
  | "execute"
  | "external-submit";

export type ToolFileDisplayOperation =
  | "create"
  | "write"
  | "append"
  | "edit"
  | "delete";

export type ToolErrorDomain =
  | "tool_error"
  | "runtime_error"
  | "model_error"
  | "ui_submit_error"
  | "process_error";

export type ToolErrorFactValue =
  | string
  | number
  | boolean
  | null
  | readonly ToolErrorFactValue[]
  | { readonly [key: string]: ToolErrorFactValue };

export type ToolErrorFacts = Readonly<Record<string, ToolErrorFactValue>>;

/** The proven phase that produced a failed ToolCallResult. */
export type ToolFailureAttribution = "schema_validation" | "execution_failure";

export type ToolRuntimeHint =
  | {
      readonly kind: "command_shell";
      readonly shellId: string;
      readonly label: string;
      readonly executable: string;
      readonly syntax: "cmd" | "powershell" | "posix";
      readonly platform: NodeJS.Platform;
      readonly invocation: readonly string[];
      readonly commandLineParameter: string;
      readonly notes: readonly string[];
    }
  | {
      readonly kind: "mcp_tool";
      readonly serverId: string;
      readonly protocolName: string;
      readonly readOnlyHint?: boolean;
      readonly destructiveHint?: boolean;
      readonly idempotentHint?: boolean;
      readonly openWorldHint?: boolean;
    };

/**
 * 工具的「能力契约元数据」（FR-TOOL-002）。
 *
 * 这是「工具是否需要确认 / 是否只读 / 可否并行 / 是否具备删除子能力」等能力判定的
 * **唯一依据**。能力判定必须基于这些显式契约字段，而非工具名正则、关键字或硬编码白名单。
 *
 * 对模型可见的工具，`validateModelVisibleToolContract` 只把 `category` / `riskLevel` /
 * `operationType` / `requiresConfirmation` 以及可选的 `fileOperation` 作为执行/副作用事实校验。
 * 预览长度、折叠和用户可见文案属于 Panel/read-model，不进入工具执行契约。
 *
 * 确认策略保守默认：当 `requiresConfirmation` 缺失（例如经松散运行时数据绕过完备门槛的
 * 兼容/MCP 路径）时，`resolveEffectiveConfirmationRequirement` 对高影响动作
 * （execute / external-submit / delete / high risk）默认按需确认，确保不会因契约字段缺失
 * 而静默执行高影响动作。
 */
export type ToolDefinitionMetadata = {
  /** 工具类别，用于归类与可见性 scope 派生。 */
  readonly category: ToolCategory;
  /** 风险等级，能力判定（如默认确认策略）的依据之一。 */
  readonly riskLevel: ToolRiskLevel;
  /** 粗粒度读写执行分类；并行许可以 `operationType === "read-only"` 全员只读为前提。 */
  readonly operationType: ToolOperationType;
  /** 显式确认策略：是否需要逐条确认。能力判定唯一依据，缺失时走保守默认。 */
  readonly requiresConfirmation: boolean;
  readonly runtimeHints?: readonly ToolRuntimeHint[];
  /**
   * 文件系统操作工具显式声明的文件操作子类型（create/write/append/edit/delete）。
   *
   * 这是工具自身声明的显式能力契约，用于工作区能力判定（例如是否具备删除能力），
   * 取代按工具名正则猜测。只有真正执行文件操作的 builtin 工具才声明该字段；
   * 非文件工具（搜索、命令、HTTP、MCP 等）不声明，判定时按 undefined 处理。
   *
   * 注意：`operationType` 是粗粒度读写执行分类，无法区分“删除”这类子能力；
   * 删除工具的 `operationType` 仍是 "read-write"（删除属于写操作），删除子能力由本字段表达。
   */
  readonly fileOperation?: ToolFileDisplayOperation;
};

export type ToolContinuation = {
  readonly ref?: string;
  readonly nextInput?: ToolFactValue;
  readonly note?: string;
};

export type ToolResultError = {
  readonly message: string;
  readonly domain?: ToolErrorDomain;
  readonly facts?: ToolErrorFacts;
  readonly retryable?: boolean;
};

export type ToolResult = {
  readonly body:
    | { readonly format: "none" }
    | { readonly format: "text"; readonly text: string }
    | { readonly format: "json"; readonly value: ToolFactValue };
  readonly error?: ToolResultError;
};

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  /** Optional provider/MCP output contract, retained without forcing validation. */
  readonly outputSchema?: ToolJsonSchema;
  readonly metadata?: ToolDefinitionMetadata;
};

export type ToolCallRequest = {
  /** Provider/protocol call id. It must be returned unchanged to the originating model. */
  readonly callId: string;
  /** Synech fact identity when the provider call id is only unique inside a nested run. */
  readonly factId?: string;
  /** The delegated AgentTool fact that owns this nested mechanical tool call. */
  readonly parentToolCallFactId?: string;
  readonly toolName: string;
  readonly input: ToolFactValue | undefined;
};

/**
 * Measurement facts for one AgentTool delegation. The parent run remains the
 * owner of the tool result; this records only the child work it delegated.
 */
export type DelegatedAgentExecutionMetadata = {
  readonly modelRounds: number;
  readonly toolCallCount: number;
  readonly usage: DelegatedAgentUsage;
};

/** Usage attributable to one delegated AgentTool invocation, independent of a model adapter. */
export type DelegatedAgentUsage = {
  readonly requestCount?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly uncachedInputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly estimatedCostUsd?: number;
};

export type ToolCallResult = {
  /** Provider/protocol call id. It must be returned unchanged to the originating model. */
  readonly callId: string;
  /** Synech fact identity when the provider call id is only unique inside a nested run. */
  readonly factId?: string;
  /** The delegated AgentTool fact that owns this nested mechanical tool call. */
  readonly parentToolCallFactId?: string;
  readonly toolName: string;
  readonly input: ToolFactValue | undefined;
  readonly output: ToolFactValue | undefined;
  /** JSON-safe identity retained across restart for Pi Session image reconciliation. */
  readonly modelAttachmentRefs?: readonly ModelInputAttachmentRef[];
  readonly status: "completed" | "failed" | "approval_required" | "cancelled";
  readonly error?: string;
  readonly errorDomain?: ToolErrorDomain;
  readonly errorFacts?: ToolErrorFacts;
  /** Present only when the runtime can prove the phase that produced this failure. */
  readonly failureAttribution?: ToolFailureAttribution;
  /** Present only for a completed, failed, or cancelled delegated AgentTool invocation. */
  readonly delegatedExecution?: DelegatedAgentExecutionMetadata;
  readonly durationMs: number;
  readonly confirmationRequest?: ConfirmationRequest;
};

export function toolCallFactId(value: Pick<ToolCallRequest, "callId" | "factId">): string {
  return value.factId ?? value.callId;
}

export type ToolSecurityDecision =
  | {
      readonly decision: "allow";
      readonly reason: string;
    }
  | {
      readonly decision: "approval_required";
      readonly reason: string;
      readonly title: string;
      readonly actionSummary: string;
      readonly consequence?: string;
      readonly affectedResources: readonly string[];
      readonly riskLevel: ToolRiskLevel;
      readonly sourceRefs: readonly string[];
    }
  | {
      readonly decision: "blocked";
      readonly reason: string;
      readonly code: string;
      readonly affectedResources: readonly string[];
      readonly sourceRefs: readonly string[];
    };

export type ToolSecurityEvaluationContext = {
  readonly platform: NodeJS.Platform;
  readonly approvedConfirmationIds?: readonly string[];
  readonly confirmationPolicy?: ToolConfirmationPolicy;
  readonly workspaceRoot?: string;
};

export interface ToolSecurityPolicy {
  evaluateToolCall(request: ToolCallRequest, definition: ToolDefinition, context: ToolSecurityEvaluationContext): ToolSecurityDecision;
}

/** Host-owned product scope carried through neutral tool execution facts. */
export type ToolExecutionResourceScope = {
  readonly ownerKind: string;
  readonly ownerId: string;
};

export type ToolExecutionContext = {
  readonly callerAgentId: string;
  readonly traceId: string;
  readonly goalId: string;
  readonly conversationId?: string;
  readonly resourceScope?: ToolExecutionResourceScope;
  readonly toolCallId?: string;
  readonly approvedConfirmationIds?: readonly string[];
  readonly confirmationPolicy?: ToolConfirmationPolicy;
  readonly abortSignal?: AbortSignal;
  /** Live-only bounded execution evidence. Reporting must never change the tool outcome. */
  readonly reportProgress?: (progress: ToolExecutionProgress) => void;
};

export type ToolExecutionProgress =
  | {
      readonly kind: "command_output";
      readonly stdoutTail?: string;
      readonly stderrTail?: string;
      readonly stdoutChars: number;
      readonly stderrChars: number;
    }
  | {
      readonly kind: "mcp_progress";
      readonly progress?: number;
      readonly total?: number;
      readonly message?: string;
    };

export type ToolCallProgress = Pick<ToolCallRequest, "callId" | "factId" | "toolName"> & {
  readonly progress: ToolExecutionProgress;
};

export type ToolPermissionCheck = {
  readonly callerAgentId: string;
  readonly allowedTools: readonly string[];
  readonly approvedConfirmationIds?: readonly string[];
  readonly confirmationPolicy?: ToolConfirmationPolicy;
};

export type ToolConfirmationPolicy = "prompt" | "full_access";

export type SandboxOperation =
  | "read"
  | "list"
  | "search"
  | "write"
  | "edit"
  | "delete"
  | "execute";

export type SandboxPolicyRequest = {
  readonly operation: SandboxOperation;
  readonly workspaceRoot: string;
  readonly relativePath?: string;
  readonly bytes?: number;
  readonly command?: string;
  readonly commandLine?: string;
  readonly args?: readonly string[];
};

export type SandboxPolicyDecision =
  | {
      readonly allowed: true;
    }
  | {
      readonly allowed: false;
      readonly code: string;
      readonly reason: string;
    };

export interface SandboxPolicy {
  check(request: SandboxPolicyRequest): SandboxPolicyDecision;
}

export interface ToolExecutor {
  readonly definition: ToolDefinition;
  execute(input: unknown, context: ToolExecutionContext): Promise<unknown | ToolExecutorResult>;
}

export type ToolExecutorResult = {
  readonly kind: "tool_call_result";
  readonly result: ToolCallResult;
};

export interface ToolExecutionBroker {
  list(): ToolDefinition[];
  has(name: string): boolean;
  execute(
    request: ToolCallRequest,
    context: ToolExecutionContext,
    permission: ToolPermissionCheck
  ): Promise<ToolCallResult>;
  register?(executor: ToolExecutor): void;
}

/**
 * A side-effect-free decision about whether one exact tool call may enter its executor.
 * `ready.request` is the detached, JSON-safe fact that a later execution will use.
 */
export type ToolExecutionPreflight =
  | {
      readonly status: "ready";
      readonly request: ToolCallRequest;
    }
  | {
      readonly status: "approval_required";
      readonly result: ToolCallResult & { readonly status: "approval_required" };
    }
  | {
      readonly status: "blocked";
      readonly result: ToolCallResult & { readonly status: "failed" | "cancelled" };
    };

/**
 * Production tool gateways expose the same authorization boundary independently from
 * execution so an outer runtime can pause before invoking a side-effecting executor.
 */
export interface ToolExecutionGateway extends ToolExecutionBroker {
  preflight(
    request: ToolCallRequest,
    context: ToolExecutionContext,
    permission: ToolPermissionCheck
  ): ToolExecutionPreflight;
  /** Applies the same model-delivery envelope to a tool-like fact produced outside a registered executor. */
  deliverResult?(
    result: ToolCallResult,
    permission: ToolPermissionCheck,
    ownerId: string,
  ): Promise<ToolCallResult>;
}
