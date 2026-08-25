import { executionErrorFacts } from "../execution-errors/index.js";
import {
  OrdinaryFeatureError,
  type OrdinaryRunEvent,
  type OrdinaryRunState,
  type OrdinaryRunStatus,
} from "./contracts.js";

export type TerminalOrdinaryRunStatus = Extract<
  OrdinaryRunStatus,
  { readonly kind: "completed" | "failed" | "cancelled" | "blocked" }
>;

export function isTerminalStatus(status: OrdinaryRunStatus): status is TerminalOrdinaryRunStatus {
  return status.kind === "completed" || status.kind === "failed" ||
    status.kind === "cancelled" || status.kind === "blocked";
}

export function isTerminal(
  state: OrdinaryRunState,
): state is OrdinaryRunState & { readonly status: TerminalOrdinaryRunStatus } {
  return isTerminalStatus(state.status);
}

export function isTerminalEvent(event: OrdinaryRunEvent): boolean {
  return event.type === "run.completed" || event.type === "run.failed" ||
    event.type === "run.cancelled" || event.type === "run.blocked";
}

export function cancellationReason(value: unknown): string {
  return typeof value === "string" ? value : "cancelled";
}

export function ordinaryExecutionFailureFacts(value: unknown): { readonly code: string; readonly message: string } {
  const explicit = executionErrorFacts(value);
  if (explicit !== undefined) return explicit;
  if (value instanceof OrdinaryFeatureError) return { code: value.code, message: value.message };
  return {
    code: "ordinary_execution_failed",
    message: value instanceof Error ? value.message : String(value),
  };
}
