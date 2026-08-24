import type { OrdinaryConversationControlDocument } from "./contracts.js";

export type ConversationCleanupDisposition = "retain_tombstone" | "delete_uncommitted";

export type ConversationCleanupRequest = {
  readonly control: OrdinaryConversationControlDocument;
  readonly runIds: readonly string[];
  readonly disposition: ConversationCleanupDisposition;
};

export type ConversationCleanupJob = {
  activeTask?: Promise<boolean>;
  pendingUncommitted?: ConversationCleanupRequest;
};

export function createConversationCleanupJob(): ConversationCleanupJob {
  return {};
}

export function prepareConversationCleanup(
  job: ConversationCleanupJob,
  control: OrdinaryConversationControlDocument,
  runIds: readonly string[],
  disposition: ConversationCleanupDisposition,
): ConversationCleanupRequest {
  if (disposition === "retain_tombstone") {
    return { control, runIds, disposition };
  }

  const pending = job.pendingUncommitted;
  const request: ConversationCleanupRequest = {
    control: pending === undefined || control.revision >= pending.control.revision
      ? control
      : pending.control,
    runIds: [...new Set([...(pending?.runIds ?? []), ...runIds])],
    disposition,
  };
  job.pendingUncommitted = request;
  return request;
}

export function recordConversationCleanupSuccess(
  job: ConversationCleanupJob,
  request: ConversationCleanupRequest,
): void {
  if (job.pendingUncommitted === request) job.pendingUncommitted = undefined;
}

export function conversationCleanupJobIsIdle(job: ConversationCleanupJob): boolean {
  return job.activeTask === undefined &&
    job.pendingUncommitted === undefined;
}
