import type { ConversationOwner } from "../../../domain/execution-scope/index.js";
import { isConversationOwnerContextRef } from "../../../domain/ordinary/index.js";
import type {
  OrdinaryConversationReadModel,
  OrdinaryConversationTurnReadModel,
  OrdinaryRunState,
} from "../../ordinary-agent/contracts.js";
import type {
  OrdinaryPanelConversation,
  OrdinaryPanelConversationPendingAction,
  OrdinaryPanelConversationStatus,
  OrdinaryPanelConversationSummary,
  OrdinaryPanelConversationTurn,
  OrdinaryPanelConversationTurnAttachment,
  OrdinaryPanelRunView,
} from "../../panel-api/ordinary-agent.js";
import { workspaceFolderSummaryFromPath } from "../../context/workspace-folder-summary.js";

export function projectOrdinaryConversation(input: {
  readonly conversation: OrdinaryConversationReadModel;
  readonly owner?: ConversationOwner;
  readonly spaceId?: string;
  readonly currentRun?: OrdinaryPanelRunView;
  readonly workspaceRun?: OrdinaryRunState;
}): OrdinaryPanelConversation {
  const turns = input.conversation.turns.map(projectConversationTurn);
  const activeAssistant = input.conversation.activeRunId === undefined
    ? undefined
    : input.conversation.turns.find((turn) =>
        turn.role === "assistant" && turn.runId === input.conversation.activeRunId);
  const pendingAction = pendingConversationAction(activeAssistant);
  const status = conversationStatus(activeAssistant ?? input.conversation.turns.at(-1));
  const latestText = [...turns].reverse().find((turn) => turn.content.length > 0)?.content ?? "";
  return {
    conversationId: input.conversation.conversationId,
    owner: input.owner,
    spaceId: input.spaceId,
    title: input.conversation.title,
    titleEditedAt: input.conversation.titleEditedAt,
    preview: compact(latestText, 180),
    currentAction: conversationCurrentAction(status, pendingAction, input.currentRun),
    nextStep: conversationNextStep(status),
    createdAt: input.conversation.createdAt,
    updatedAt: input.conversation.updatedAt,
    pinnedAt: input.conversation.pinnedAt,
    status,
    activeRunId: input.conversation.activeRunId,
    latestRunId: input.conversation.latestRunId,
    workspaceFolder: workspaceFolderSummaryFromPath(
      input.workspaceRun?.birth.capabilitySnapshot.executionRoot,
      input.workspaceRun?.birth.workspaceSelection ?? "default",
    ),
    requiresUserAction: pendingAction !== undefined,
    pendingAction,
    queuedRunIds: input.conversation.queuedRunIds,
    queuedRunCount: input.conversation.queuedRunIds.length,
    currentRun: input.currentRun,
    turns,
  };
}

export function projectOrdinaryConversationSummary(
  conversation: OrdinaryConversationReadModel,
  workspaceRun?: OrdinaryRunState,
  spaceId?: string,
  owner?: ConversationOwner,
): OrdinaryPanelConversationSummary {
  const { turns: _turns, currentRun: _currentRun, ...summary } = projectOrdinaryConversation({
    conversation,
    owner,
    workspaceRun,
    spaceId,
  });
  return summary;
}

function projectConversationTurn(turn: OrdinaryConversationTurnReadModel): OrdinaryPanelConversationTurn {
  if (turn.role === "user") {
    return {
      turnId: turn.turnId,
      role: turn.role,
      title: "你的消息",
      content: turn.content,
      status: turn.status,
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt,
      runId: turn.runId,
      attachments: projectConversationAttachments(turn),
    };
  }
  return {
    turnId: turn.turnId,
    role: turn.role,
    title: "",
    content: turn.content,
    status: conversationTurnStatus(turn.status),
    failure: turn.failure,
    interruption: turn.interruption,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    runId: turn.runId,
    responseModel: {
      profileId: turn.model.profileId,
      label: turn.model.label,
      providerKind: turn.model.providerKind,
      protocolKind: turn.model.protocolKind,
      baseUrl: turn.model.baseUrl,
      model: turn.model.model,
    },
  };
}

function projectConversationAttachments(
  turn: Extract<OrdinaryConversationTurnReadModel, { readonly role: "user" }>,
): readonly OrdinaryPanelConversationTurnAttachment[] | undefined {
  const attachments = (turn.input.context?.contextRefs ?? [])
    .filter((ref) => !isConversationOwnerContextRef(ref))
    .map((ref): OrdinaryPanelConversationTurnAttachment => ({
      attachmentId: ref.attachmentId ?? ref.ref,
      kind: ref.kind,
      title: ref.title ?? attachmentTitle(ref.kind, ref.ref),
      summary: ref.summary,
      readonlyPreviewMeta: {
        available: ref.metadata?.available,
        title: ref.title ?? ref.readonlyPreview?.title,
        byteLength: ref.metadata?.byteLength,
        mimeType: ref.metadata?.mimeType,
        truncated: ref.metadata?.truncated,
      },
      mediaPreview: ref.attachmentId !== undefined && ref.metadata?.mimeType?.startsWith("image/")
        ? {
            kind: "image",
            url: `/api/context/attachments/media/${encodeURIComponent(ref.attachmentId)}`,
            mimeType: ref.metadata.mimeType,
            byteLength: ref.metadata.byteLength,
          }
        : undefined,
    }));
  return attachments.length === 0 ? undefined : attachments;
}

function conversationTurnStatus(
  status: Extract<OrdinaryConversationTurnReadModel, { readonly role: "assistant" }>["status"],
): OrdinaryPanelConversationTurn["status"] {
  if (status === "queued") return "pending";
  if (status === "awaiting_approval") return "running";
  return status;
}

function conversationStatus(
  turn: OrdinaryConversationTurnReadModel | undefined,
): OrdinaryPanelConversationStatus {
  if (turn === undefined) return "idle";
  if (turn.role === "user") return turn.status === "pending" ? "pending" : "idle";
  if (turn.status === "queued") return "pending";
  if (turn.status === "awaiting_approval") return "approval_needed";
  return turn.status;
}

function pendingConversationAction(
  turn: OrdinaryConversationTurnReadModel | undefined,
): OrdinaryPanelConversationPendingAction | undefined {
  if (turn?.role !== "assistant" || turn.status !== "awaiting_approval") return undefined;
  return { kind: "approval", runId: turn.runId, assistantTurnId: turn.turnId };
}

function conversationCurrentAction(
  status: OrdinaryPanelConversationStatus,
  pending: OrdinaryPanelConversationPendingAction | undefined,
  currentRun: OrdinaryPanelRunView | undefined,
): string {
  if (pending !== undefined) return currentRun?.workView.pendingConfirmation?.actionSummary ?? "等待确认";
  if (status === "running") return currentRun?.workView.currentAction ?? "正在处理";
  if (status === "pending") return "等待处理";
  return "";
}

function conversationNextStep(status: OrdinaryPanelConversationStatus): string {
  if (status === "approval_needed") return "等待你的决定";
  if (status === "running" || status === "pending") return "继续运行";
  return "";
}

function attachmentTitle(kind: "workspace" | "file" | "project" | "web", ref: string): string {
  const value = ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref;
  if (kind === "workspace") return "当前工作区";
  if (kind === "file") return value.split(/[\\/]/u).at(-1) || value;
  return value;
}

function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
