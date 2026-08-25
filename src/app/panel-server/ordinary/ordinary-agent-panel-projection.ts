import type { ConversationOwner } from "../../../domain/execution-scope/index.js";
import type {
  OrdinaryConversationReadModel,
  OrdinaryRunActivityCursor,
  OrdinaryRunActivityReplay,
  OrdinaryRunState,
} from "../../ordinary-agent/contracts.js";
import type {
  OrdinaryPanelConversation,
  OrdinaryPanelConversationSummary,
  OrdinaryPanelReplayCursor,
  OrdinaryPanelRunEvent as RunEvent,
  OrdinaryPanelRunView,
  OrdinaryPanelWorkView,
} from "../../panel-api/ordinary-agent.js";
import {
  isOrdinaryWorkViewEvent,
  projectOrdinaryActivity,
  projectOrdinaryTranscriptNodes,
} from "./ordinary-activity-projection.js";
import {
  projectOrdinaryConversation,
  projectOrdinaryConversationSummary,
} from "./ordinary-conversation-projection.js";
import {
  continuationAvailability,
  currentAction,
  pendingConfirmationFrom,
  projectCapabilityResolution,
  projectContextAttachments,
  projectOrdinaryRun,
  runError,
  stopReason,
  workHeadline,
  workStage,
  workSummary,
} from "./ordinary-run-projection.js";

export type {
  OrdinaryPanelRun,
  OrdinaryPanelCapabilityResolution,
  OrdinaryPanelReplayCursor,
  OrdinaryPanelRunDetail,
  OrdinaryPanelRunView,
  OrdinaryPanelWorkView,
} from "../../panel-api/ordinary-agent.js";

export type OrdinaryPanelActivityBatch = {
  readonly runId: string;
  readonly reset: boolean;
  readonly events: readonly RunEvent[];
  readonly cursor: OrdinaryPanelReplayCursor;
};

export class OrdinaryPanelCursorError extends Error {
  readonly name = "OrdinaryPanelCursorError";
  readonly code = "ordinary_panel_cursor_invalid" as const;
}

export function encodeOrdinaryPanelCursor(cursor: OrdinaryRunActivityCursor): string {
  return Buffer.from(JSON.stringify({ streamId: cursor.streamId, sequence: cursor.sequence }), "utf8")
    .toString("base64url");
}

export function parseOrdinaryPanelCursor(value: string | undefined): OrdinaryRunActivityCursor | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value.length > 1_024 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw invalidCursor();
  let raw: unknown;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw invalidCursor();
    raw = JSON.parse(decoded.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof OrdinaryPanelCursorError) throw error;
    throw invalidCursor();
  }
  if (!isExactCursorRecord(raw)) throw invalidCursor();
  return { streamId: raw.streamId, sequence: raw.sequence };
}

export function projectOrdinaryPanelActivityBatch(input: {
  readonly run: OrdinaryRunState;
  readonly replay: OrdinaryRunActivityReplay;
}): OrdinaryPanelActivityBatch {
  return {
    runId: input.run.runId,
    reset: input.replay.reset,
    events: input.replay.activities.map((activity) => projectOrdinaryActivity(input.run, activity)),
    cursor: panelCursor(input.replay.cursor),
  };
}

export function projectOrdinaryPanelRunView(input: {
  readonly run: OrdinaryRunState;
  /** Complete current-generation activity history for the work view. */
  readonly fullReplay: OrdinaryRunActivityReplay;
  /** Requested incremental replay for the response cursor. */
  readonly replay?: OrdinaryRunActivityReplay;
}): OrdinaryPanelRunView {
  const fullEvents = input.fullReplay.activities.map((activity) => projectOrdinaryActivity(input.run, activity));
  const replay = input.replay ?? input.fullReplay;
  const run = projectOrdinaryRun(input.run, input.fullReplay.cursor, fullEvents.length);
  const pendingConfirmation = pendingConfirmationFrom(input.run);
  const completedAnswer = input.fullReplay.activities
    .filter((activity) => activity.type === "model.output.completed")
    .at(-1)?.content;
  if (input.run.status.kind === "completed" && completedAnswer === undefined) {
    throw new Error(`Completed Ordinary run ${input.run.runId} has no projected Session answer`);
  }
  const answer = input.run.status.kind === "completed"
    ? { title: "", content: completedAnswer!, evidenceRefs: [], nextActions: [] }
    : undefined;
  const transcriptNodes = projectOrdinaryTranscriptNodes(input.run, input.fullReplay.activities);
  const contextAttachments = projectContextAttachments(input.run);
  const workView: OrdinaryPanelWorkView = {
    run,
    stage: workStage(input.run, fullEvents),
    headline: workHeadline(input.run),
    currentAction: currentAction(input.run),
    contextAttachments,
    pendingConfirmation,
    answer,
    deliverable: undefined,
    visibleEvents: fullEvents.filter((event) => isOrdinaryWorkViewEvent(input.run, event)),
    transcriptNodes,
    workSummary: {
      summary: workSummary(input.run.toolCalls.length, contextAttachments.length, pendingConfirmation !== undefined),
      pendingActionCount: pendingConfirmation === undefined ? 0 : 1,
      toolResultCount: input.run.toolCalls.length,
      contextAttachmentCount: contextAttachments.length,
    },
  };
  return {
    run,
    agentDefinitionRef: input.run.birth.agentDefinitionRef,
    capabilityResolution: projectCapabilityResolution(input.run.capabilityResolution),
    workView,
    detail: {
      runId: input.run.runId,
      status: run.status,
      error: runError(input.run),
      stopReason: stopReason(input.run),
      continuationAvailability: continuationAvailability(input.run),
      transcript: { transcriptNodes },
      toolResults: structuredClone(input.run.toolCalls),
      usage: structuredClone(input.run.usage),
    },
    replay: {
      reset: replay.reset,
      events: replay.activities.map((activity) => projectOrdinaryActivity(input.run, activity)),
      cursor: panelCursor(replay.cursor),
    },
  };
}

export function projectOrdinaryPanelConversation(input: {
  readonly conversation: OrdinaryConversationReadModel;
  readonly owner?: ConversationOwner;
  readonly spaceId?: string;
  readonly currentRun?: OrdinaryPanelRunView;
  readonly workspaceRun?: OrdinaryRunState;
}): OrdinaryPanelConversation {
  return projectOrdinaryConversation(input);
}

export function projectOrdinaryPanelConversationSummary(
  conversation: OrdinaryConversationReadModel,
  workspaceRun?: OrdinaryRunState,
  spaceId?: string,
  owner?: ConversationOwner,
): OrdinaryPanelConversationSummary {
  return projectOrdinaryConversationSummary(conversation, workspaceRun, spaceId, owner);
}

function panelCursor(cursor: OrdinaryRunActivityCursor): OrdinaryPanelReplayCursor {
  return { token: encodeOrdinaryPanelCursor(cursor), lastSequence: cursor.sequence };
}

function isExactCursorRecord(value: unknown): value is { readonly streamId: string; readonly sequence: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  return keys.length === 2 && keys[0] === "sequence" && keys[1] === "streamId" &&
    typeof record.streamId === "string" && record.streamId.length > 0 &&
    typeof record.sequence === "number" && Number.isSafeInteger(record.sequence) && record.sequence >= 0;
}

function invalidCursor(): OrdinaryPanelCursorError {
  return new OrdinaryPanelCursorError("Ordinary activity cursor is invalid.");
}
