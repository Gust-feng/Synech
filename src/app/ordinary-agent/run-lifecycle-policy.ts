import { executionErrorFacts } from "../execution-errors/index.js";
import { OrdinaryFeatureError, type OrdinaryRunEvent, type OrdinaryRunState } from "./contracts.js";

export function isTerminal(state: OrdinaryRunState): boolean {
  return state.status.kind === "completed" || state.status.kind === "failed" ||
    state.status.kind === "cancelled" || state.status.kind === "blocked";
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
