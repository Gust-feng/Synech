import { toolInvocationId, type ToolCallRequest, type ToolCallResult } from "../../domain/tools/index.js";
import type { OrdinaryRunEvent } from "./contracts.js";
import { ordinaryToolResultKey } from "./state.js";

export function toolInvocationIds(event: OrdinaryRunEvent): readonly string[] {
  return "invocationIds" in event ? event.invocationIds : [];
}

export function toolActivityId(result: ToolCallResult): string {
  return `tool:${ordinaryToolResultKey(result)}`;
}

export function liveToolActivityId(identity: Pick<ToolCallRequest, "invocationId">): string {
  return `tool-live:${toolInvocationId(identity)}`;
}
