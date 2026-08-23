import type { ConfirmationDecision, ConfirmationRequest } from "../../domain/confirmation/index.js";
import type { ModelMessage, ModelUsage } from "../../domain/intelligence/index.js";
import type {
  ToolCallResult,
  ToolCallProgress,
  ToolCallRequest,
  ToolExecutionContext,
  ToolExecutionGateway,
  ToolFactValue,
  ToolDefinition,
  ToolPermissionCheck,
} from "../../domain/tools/index.js";
import type { ProgressiveToolVisibilityCostGate } from "./tool-definition-visibility-cost.js";
import type { AgentSessionExecutionRefs, AgentSessionWriteCheckpoint } from "./agent-session.js";

export type AgentLoopToolBoundary = {
  /** Complete model contracts frozen when the owning run was created. */
  readonly definitions: readonly ToolDefinition[];
  readonly gateway: ToolExecutionGateway;
  readonly context: ToolExecutionContext;
  readonly permission: ToolPermissionCheck;
};

/** One feature-owned specialist exposed to the parent model as a tool. */
export type AgentLoopAgentToolInvocation = {
  readonly agentName: string;
  readonly instructions: string;
  readonly input: string;
  readonly callerAgentId: string;
  readonly allowedTools: readonly string[];
};

/**
 * Provider-neutral agents-as-tools contribution. The model adapter owns the nested
 * model loop; the contributing feature owns definition lookup and permission narrowing.
 */
export type AgentLoopAgentTool = {
  readonly toolName: string;
  resolve(input: ToolFactValue): Promise<AgentLoopAgentToolInvocation>;
};

/**
 * Compact, run-frozen catalog information for a deferred tool. The complete
 * input/output contract stays in the corresponding frozen ToolDefinition and
 * is only made model-visible after an explicit load operation.
 */
export type AgentLoopDeferredToolCatalogEntry = {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly source: {
    readonly kind: "mcp";
    readonly id: string;
    readonly label: string;
  };
  readonly definitionHash: string;
};

/**
 * Provider-neutral model visibility policy for one frozen run. `allowedTools`
 * remains the complete execution permission set; this plan only controls which
 * already-authorized definitions are active in the next model request.
 */
export type AgentLoopToolVisibilityPlan = {
  readonly policyId: "mcp-progressive/v1";
  readonly snapshotId: string;
  /** Frozen economics reused when a delegated Agent receives a narrower tool set. */
  readonly costGate: ProgressiveToolVisibilityCostGate;
  readonly initiallyVisibleToolNames: readonly string[];
  readonly deferredTools: readonly AgentLoopDeferredToolCatalogEntry[];
  readonly controls: {
    readonly search: ToolDefinition;
    readonly load: ToolDefinition;
  };
};

export type AgentLoopInput = {
  readonly instructions: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: AgentLoopToolBoundary;
  readonly agentTools?: readonly AgentLoopAgentTool[];
  /** Optional run-frozen progressive model visibility policy. */
  readonly toolVisibilityPlan?: AgentLoopToolVisibilityPlan;
  readonly abortSignal: AbortSignal;
  readonly onTextDelta?: (delta: string) => void;
  /** Provider-normalized visible reasoning text for the active model turn. */
  readonly onReasoningDelta?: (delta: string) => void;
  /** Authoritative complete reasoning text observed at the model response boundary. */
  readonly onReasoningCompleted?: (content: string) => Promise<void>;
  /** Emitted once when an exact tool request enters its execution boundary. */
  readonly onToolRequested?: (request: ToolCallRequest) => void;
  /** Resolves after the owner atomically accepts one provider-emitted nested tool batch. */
  readonly onNestedToolRequestsAccepted?: (requests: readonly ToolCallRequest[]) => Promise<void>;
  /** Live-only bounded progress emitted by the active tool executor. */
  readonly onToolProgress?: (progress: ToolCallProgress) => void;
  /** Resolves only after the owning feature has durably accepted the executed tool fact. */
  readonly onToolResult?: (result: ToolCallResult) => Promise<void>;
  /** Resolves after the owning feature durably accepts a provider-owned Session checkpoint. */
  readonly onSessionWriteCheckpoint?: (checkpoint: AgentSessionWriteCheckpoint) => Promise<void>;
};

export type AgentLoopContinuation = {
  readonly availability: "live_only";
  decide(input: ({
    readonly decision: ConfirmationDecision;
  } | {
    readonly decisions: readonly ConfirmationDecision[];
  }) & {
    readonly abortSignal: AbortSignal;
  }): Promise<AgentLoopResult>;
};

type AgentLoopResultFacts = {
  readonly toolResults: readonly ToolCallResult[];
  /** Cumulative usage for this execute/continuation chain, not a per-resume delta. */
  readonly usage: ModelUsage;
  readonly confirmationRequests: readonly ConfirmationRequest[];
  /** Optional for adapters that do not persist a model session for this execution. */
  readonly session?: AgentSessionExecutionRefs;
};

export type AgentLoopResult =
  | (AgentLoopResultFacts & {
      readonly status: "completed";
      readonly finalText: string;
    })
  | (AgentLoopResultFacts & {
      readonly status: "approval_required";
      readonly continuation: AgentLoopContinuation;
    })
  | (AgentLoopResultFacts & {
      readonly status: "cancelled";
      readonly error?: string;
    })
  | (AgentLoopResultFacts & {
      readonly status: "failed";
      readonly error: string;
      /** Stable mechanical failure classification when the adapter can prove one. */
      readonly errorCode?: string;
    });

/** Mechanical model-tool-model execution. Business completion remains feature-owned. */
export interface AgentLoop {
  execute(input: AgentLoopInput): Promise<AgentLoopResult>;
  release(): Promise<void>;
}
