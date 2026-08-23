import type { ModelCapabilities } from "../../domain/config/index.js";
import type { IntelligenceChannel, ModelMessage, ModelUsage } from "../../domain/intelligence/index.js";
import type { ToolDefinition } from "../../domain/tools/index.js";

export type AgentLoopTokenCounter = {
  readonly source: "openai_tiktoken";
  readonly model: string;
  /** Whether js-tiktoken recognized this exact model instead of using a generic encoding fallback. */
  readonly tokenizerMatch?: "model" | "fallback";
  countText(text: string): number;
  countMessage(message: ModelMessage): number;
  countMessages(messages: readonly ModelMessage[]): number;
};

export type AgentLoopContextSummary = {
  readonly summaryId: string;
  readonly summary: string;
  readonly coveredRefs: readonly string[];
  readonly modelRequestId: string;
  readonly modelResponseId?: string;
};

export type AgentLoopContextMaintenanceResult =
  | {
      readonly status: "unchanged";
      readonly tokenCount: number;
      readonly threshold: number;
    }
  | {
      readonly status: "compacted";
      readonly tokenCount: number;
      readonly threshold: number;
      readonly messages: readonly ModelMessage[];
      readonly conversationSummary: AgentLoopContextSummary;
      readonly usage?: ModelUsage;
    }
  | {
      readonly status: "failed";
      readonly tokenCount: number;
      readonly threshold: number;
      readonly message: string;
      readonly requestId?: string;
      readonly responseId?: string;
      readonly usage?: ModelUsage;
    };

export type MaintainAgentLoopContextInput = {
  readonly goal: string;
  readonly traceId: string;
  readonly goalId: string;
  readonly agentIdentity?: {
    readonly agentId: string;
    readonly displayName: string;
  };
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly intelligenceChannel: IntelligenceChannel;
  /** Frozen run capability: the sole capacity basis for context compaction. */
  readonly modelCapabilities: ModelCapabilities;
  /** Counter selected for the frozen run model; no generic tokenizer fallback is allowed here. */
  readonly tokenCounter: AgentLoopTokenCounter;
  readonly thresholdRatio?: number;
  /** Token budget for the optional recent interaction tail. */
  readonly preserveRecentTokenBudget?: number;
  /** Defaults to system for existing runtimes; SDK-backed Ordinary uses user to keep one leading system instruction. */
  readonly compactedContextRole?: "system" | "user";
  /** Keep the latest complete tool interaction raw while compacting older context. */
  readonly preserveLatestToolInteraction?: boolean;
  readonly abortSignal?: AbortSignal;
};
