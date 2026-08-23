import type { ToolCallResult } from "../../../domain/tools";
import type { ActivityItem } from "../../panel-read-model/transcript/panel-transcript-activity-copy";
import type { TranscriptNode } from "./contracts/run";

export function toolResultForActivity(
  item: ActivityItem,
  nodes: readonly TranscriptNode[],
  toolResultsByRunId: Readonly<Record<string, readonly ToolCallResult[]>>,
): ToolCallResult | undefined {
  if (item.toolCallFactId === undefined) return undefined;
  const runId = nodes.find((node) => node.nodeId === item.nodeId)?.runId;
  if (runId === undefined) return undefined;
  return toolResultsByRunId[runId]?.find((result) => (result.factId ?? result.callId) === item.toolCallFactId);
}