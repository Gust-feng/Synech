import type { ToolOperationType } from "./contracts.js";

export type ToolMetricContinuationKind = "native" | "read_output";
export type ToolMetricRetentionReason =
  | "body_limit"
  | "envelope_limit"
  | "body_and_envelope_limit"
  | "serialization_failure"
  | "capacity_failure";

export type ToolResultMetricEvent = {
  readonly kind: "execution";
  readonly toolName: string;
  readonly operationType: ToolOperationType;
  readonly status: "completed" | "failed" | "approval_required" | "cancelled";
  readonly inputTokens?: number;
  readonly rawBodyTokens?: number;
  readonly rawEnvelopeTokens?: number;
  readonly finalEnvelopeTokens?: number;
  readonly outputChars?: number;
  readonly outputBytes?: number;
  readonly durationMs?: number;
  readonly retained?: {
    readonly reason: ToolMetricRetentionReason;
    readonly chars?: number;
    readonly bytes?: number;
    readonly availability?: "live_only" | "durable";
  };
  readonly retentionFailure?: ToolMetricRetentionReason;
  readonly retentionMs?: number;
  readonly continuation?: {
    readonly kind: ToolMetricContinuationKind;
    readonly offered: boolean;
    readonly completed: boolean;
    readonly chainHash?: string;
    readonly pageChars?: number;
    readonly failure?: "expired" | "read_failed";
  };
};

export type ToolDefinitionMetricEvent = {
  readonly kind: "definition";
  readonly toolName: string;
  readonly operationType: ToolOperationType;
  readonly definitionHash: string;
  readonly definitionTokens: number;
  readonly totalDefinitionTokens: number;
  readonly toolCount: number;
};

export type ToolSchedulingMetricEvent = {
  readonly kind: "scheduling";
  readonly toolName: string;
  readonly operationType: ToolOperationType;
  readonly queueWaitMs: number;
  readonly executionMs: number;
  readonly activeCount: number;
  readonly cancelledWhileQueued?: boolean;
};

export type ToolExecutionMetricEvent =
  | ToolResultMetricEvent
  | ToolDefinitionMetricEvent
  | ToolSchedulingMetricEvent;

export interface ToolExecutionMetricsSink {
  record(event: ToolExecutionMetricEvent): void;
  /** Records a sink-side loss without changing the observed tool fact. */
  recordDropped?(count?: number): void;
}
