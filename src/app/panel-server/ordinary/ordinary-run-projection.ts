import type { ConfirmationRequest } from "../../../domain/confirmation/index.js";
import type {
  OrdinaryPanelTaskStatus as AgentTaskStatus,
  PanelContextAttachment as ContextAttachment,
  OrdinaryPanelConfirmationRequest as OwnerScopedConfirmationRequest,
  OrdinaryPanelRunEvent as RunEvent,
} from "../../panel-api/ordinary-agent.js";
import type { OrdinaryRunActivityCursor, OrdinaryRunState } from "../../ordinary-agent/contracts.js";
import type {
  OrdinaryPanelCapabilityResolution,
  OrdinaryPanelRun,
  OrdinaryPanelRunDetail,
  OrdinaryPanelWorkView,
} from "../../panel-api/ordinary-agent.js";

export function projectCapabilityResolution(
  resolution: OrdinaryRunState["capabilityResolution"],
): OrdinaryPanelCapabilityResolution | undefined {
  if (resolution === undefined) return undefined;
  return {
    modelContextWindowTokens: resolution.capabilityPlan.modelCapabilities.contextWindowTokens,
  };
}

export function projectOrdinaryRun(
  state: OrdinaryRunState,
  cursor: OrdinaryRunActivityCursor,
  eventCount: number,
): OrdinaryPanelRun {
  return {
    runId: state.runId,
    conversationId: state.turn.conversationId,
    title: compact(state.input.userMessage, 120),
    goalSummary: compact(state.input.userMessage, 240),
    status: panelStatus(state),
    agentDefinitionRef: state.birth.agentDefinitionRef,
    createdAt: state.timestamps.createdAt,
    updatedAt: state.timestamps.updatedAt,
    currentStep: currentAction(state) || undefined,
    nextStep: nextStep(state) || undefined,
    requiresUserAction: state.status.kind === "awaiting_approval",
    eventCursor: { lastSequence: cursor.sequence, eventCount },
  };
}

export function projectContextAttachments(run: OrdinaryRunState): readonly ContextAttachment[] {
  const permissionRefs = run.input.context?.permissionBoundaryRefs ?? [];
  return (run.input.context?.contextRefs ?? []).map((ref, index) => ({
    attachmentId: ref.attachmentId ?? `${run.runId}:context:${index}`,
    kind: ref.kind,
    ref: ref.ref,
    title: ref.title ?? attachmentTitle(ref.kind, ref.ref),
    summary: ref.summary ?? ref.ref,
    readonlyPreview: ref.readonlyPreview === undefined
      ? undefined
      : {
          title: ref.readonlyPreview.title,
          text: ref.readonlyPreview.text,
          truncated: ref.metadata?.truncated ?? false,
        },
    permissionRefs,
    readonlyPreviewMeta: {
      available: ref.metadata?.available ?? true,
      title: ref.title ?? ref.readonlyPreview?.title,
      byteLength: ref.metadata?.byteLength,
      mimeType: ref.metadata?.mimeType,
      truncated: ref.metadata?.truncated,
    },
    status: ref.metadata?.available === false ? "blocked" : "ready",
    warning: ref.metadata?.available === false ? "��上下文当前不可用。" : undefined,
  }));
}

export function pendingConfirmationFrom(run: OrdinaryRunState): OwnerScopedConfirmationRequest | undefined {
  if (run.status.kind !== "awaiting_approval") return undefined;
  return ownerScopedConfirmation(run.runId, run.status.confirmationRequests[0]);
}

export function ownerScopedConfirmation(
  ownerRunId: string,
  request: ConfirmationRequest | undefined,
): OwnerScopedConfirmationRequest | undefined {
  return request === undefined ? undefined : { ...structuredClone(request), ownerRunId };
}

export function panelStatus(run: OrdinaryRunState): AgentTaskStatus {
  return run.status.kind === "awaiting_approval" ? "approval_needed" : run.status.kind;
}

export function workStage(
  run: OrdinaryRunState,
  events: readonly RunEvent[],
): OrdinaryPanelWorkView["stage"] {
  switch (run.status.kind) {
    case "queued": return "queued";
    case "awaiting_approval": return "awaiting_approval";
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "blocked": return "blocked";
    case "running": return events.at(-1)?.type === "model.output.delta" ? "composing_result" : "understanding";
  }
}

export function workHeadline(run: OrdinaryRunState): string {
  if (isQuietInterruption(run)) return "";
  switch (run.status.kind) {
    case "awaiting_approval": return "待处理";
    case "completed": return "已回答";
    case "failed": return "未完成";
    case "cancelled": return "已取消";
    case "blocked": return "需要处理";
    default: return "";
  }
}

export function currentAction(run: OrdinaryRunState): string {
  if (isQuietInterruption(run)) return "";
  if (run.status.kind === "awaiting_approval") {
    return run.status.confirmationRequests[0]?.actionSummary ?? "等待确认";
  }
  if (run.status.kind === "running") return "正在处理";
  if (run.status.kind === "queued") return "等待上一轮完成";
  if (run.status.kind === "failed") return run.status.error.message;
  if (run.status.kind === "blocked") return run.status.reason.message;
  return "";
}

export function nextStep(run: OrdinaryRunState): string {
  if (run.status.kind === "queued") return "上一轮完成后继续";
  if (run.status.kind === "awaiting_approval") return "等待你的决定";
  if (run.status.kind === "running") return "继续运行";
  return "";
}

export function runError(run: OrdinaryRunState): { readonly code: string; readonly message: string } | undefined {
  if (run.status.kind === "failed") return structuredClone(run.status.error);
  if (run.status.kind === "blocked") return structuredClone(run.status.reason);
  if (run.status.kind === "cancelled") return { code: "run_cancelled", message: run.status.reason };
  return undefined;
}

export function stopReason(run: OrdinaryRunState): string | undefined {
  if (run.status.kind === "awaiting_approval") return "approval_required";
  if (run.status.kind === "completed") return "completed";
  if (run.status.kind === "failed") return run.status.error.code;
  if (run.status.kind === "blocked") return run.status.reason.code;
  if (run.status.kind === "cancelled") return "cancelled";
  return undefined;
}

export function isQuietInterruption(run: OrdinaryRunState): boolean {
  return run.status.kind === "cancelled" || (
    run.status.kind === "blocked" && (
      run.status.reason.code === "execution_continuation_lost" ||
      run.status.reason.code === "confirmation_continuation_lost"
    )
  );
}

export function continuationAvailability(
  run: OrdinaryRunState,
): OrdinaryPanelRunDetail["continuationAvailability"] {
  if (run.status.kind === "awaiting_approval") return "live";
  if (run.status.kind === "blocked") {
    return run.status.reason.code === "confirmation_continuation_lost" ? "lost_after_restart" : "new_turn";
  }
  return "none";
}

export function workSummary(toolCount: number, contextCount: number, pending: boolean): string {
  const parts = [
    contextCount > 0 ? `上下文 ${contextCount}` : undefined,
    toolCount > 0 ? `工具结果 ${toolCount}` : undefined,
    pending ? "待处理 1" : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? "本轮没有额外上下文。" : parts.join("；");
}

export function modelRequestSummary(reason: "initial" | "after_tool" | "after_approval"): string {
  if (reason === "after_tool") return "分析工具结果";
  if (reason === "after_approval") return "继续处理确认结果";
  return "思考中";
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
