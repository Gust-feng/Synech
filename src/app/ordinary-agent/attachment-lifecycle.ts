import type { IdFactory } from "../../kernel/id.js";
import {
  managedAttachmentId,
  managedAttachmentRef,
  parseContextReference,
  parsePermissionBoundaryRef,
} from "../../domain/ordinary/index.js";
import { OrdinaryFeatureError, type OrdinaryRunInput } from "./contracts.js";
import {
  OrdinaryManagedAttachmentRepositoryError,
  type CreateOrdinaryManagedAttachmentDraftResult,
  type OrdinaryManagedAttachmentRecord,
  type OrdinaryManagedAttachmentRepository,
} from "./managed-attachment-repository.js";
import {
  managedAttachmentDraftId,
  type CreateManagedAttachmentDraftInput,
} from "./attachment-draft.js";

type PendingClaimRollback = {
  readonly runId: string;
  readonly conversationId: string;
  readonly attachmentIds: readonly string[];
  readonly protectedByRunId?: string;
};

type ClaimReservation = {
  readonly rollbackRunId: string;
  readonly protectedAttachmentIds: readonly string[];
};

export type ManagedAttachmentRunClaim = {
  readonly runInput: OrdinaryRunInput;
  commit(): Promise<void>;
  rollback(): Promise<void>;
};

export type ManagedAttachmentRecoveryInput = {
  readonly durableClaims: readonly {
    readonly conversationId: string;
    readonly attachmentIds: readonly string[];
  }[];
  readonly preserveConversationIds: readonly string[];
};

export type ManagedAttachmentLifecycle = ReturnType<typeof createManagedAttachmentLifecycle>;

export function createManagedAttachmentLifecycle(input: {
  readonly repository?: OrdinaryManagedAttachmentRepository;
  readonly instanceId?: string;
  readonly now: () => string;
  readonly idFactory: IdFactory;
  readonly onRecoveryIssue?: (identity: string | undefined, error: unknown) => void;
  readonly onRollbackFailure?: (rollback: {
    readonly runId: string;
    readonly conversationId: string;
    readonly attachmentIds: readonly string[];
  }, error: unknown) => void;
}) {
  if ((input.repository === undefined) !== (input.instanceId === undefined)) {
    throw new Error("Ordinary managed attachment repository and instance identity must be configured together.");
  }
  const pendingRollbacks = new Map<string, PendingClaimRollback>();

  function configured() {
    if (input.repository === undefined || input.instanceId === undefined) {
      throw new OrdinaryFeatureError(
        "ordinary_managed_attachment_unavailable",
        "Ordinary managed attachment storage is unavailable.",
      );
    }
    return { repository: input.repository, instanceId: input.instanceId };
  }

  async function recover(recovery: ManagedAttachmentRecoveryInput): Promise<void> {
    if (input.repository === undefined || input.instanceId === undefined) return;
    const durableClaims = new Map(recovery.durableClaims.flatMap(({ conversationId, attachmentIds }) =>
      attachmentIds.map((attachmentId) => [attachmentId, conversationId] as const)));
    const preserved = new Set(recovery.preserveConversationIds);
    let records: readonly OrdinaryManagedAttachmentRecord[];
    try {
      records = await input.repository.list();
    } catch (error) {
      input.onRecoveryIssue?.(undefined, error);
      return;
    }
    for (const record of records) {
      try {
        const durableConversationId = durableClaims.get(record.attachmentId);
        if (durableConversationId !== undefined) {
          if (record.owner.kind !== "conversation" || record.owner.conversationId !== durableConversationId) {
            throw new OrdinaryManagedAttachmentRepositoryError(
              "ordinary_managed_attachment_ownership_conflict",
              `Managed attachment ${record.attachmentId} does not match its durable conversation claim.`,
            );
          }
          continue;
        }
        const keep = record.owner.kind === "draft"
          ? record.owner.instanceId === input.instanceId
          : preserved.has(record.owner.conversationId);
        if (!keep) await input.repository.delete(record.attachmentId, record.owner);
      } catch (error) {
        input.onRecoveryIssue?.(record.attachmentId, error);
      }
    }
  }

  async function createDraft(
    draft: CreateManagedAttachmentDraftInput,
  ): Promise<CreateOrdinaryManagedAttachmentDraftResult> {
    const { repository, instanceId } = configured();
    try {
      return await repository.createDraft({
        attachmentId: managedAttachmentDraftId(draft, input.idFactory),
        instanceId,
        originalName: draft.originalName,
        ...(draft.mimeType === undefined ? {} : { mimeType: draft.mimeType }),
        content: draft.content,
        createdAt: input.now(),
      });
    } catch (error) {
      throw attachmentFeatureError(error);
    }
  }

  async function discardDraft(attachmentId: string): Promise<void> {
    const { repository, instanceId } = configured();
    let record: OrdinaryManagedAttachmentRecord;
    try {
      record = await repository.get(attachmentId);
    } catch (error) {
      if (isNotFound(error)) return;
      throw attachmentFeatureError(error);
    }
    if (record.owner.kind !== "draft" || record.owner.instanceId !== instanceId) {
      throw new OrdinaryFeatureError(
        "ordinary_managed_attachment_unavailable",
        `Managed attachment ${attachmentId} is not owned by this upload draft.`,
      );
    }
    await repository.delete(attachmentId, record.owner);
  }

  async function claimForRun(claimInput: {
    readonly runInput: OrdinaryRunInput;
    readonly conversationId: string;
    readonly runId: string;
  }): Promise<ManagedAttachmentRunClaim> {
    const attachmentIds = managedAttachmentIds(claimInput.runInput);
    if (attachmentIds.length === 0) return settledClaim(claimInput.runInput);
    const { repository, instanceId } = configured();
    const reservations = reservePendingRollbacks(claimInput.conversationId, claimInput.runId, attachmentIds);
    try {
      const claimed = await repository.claimForConversation({
        attachmentIds,
        instanceId,
        conversationId: claimInput.conversationId,
        claimedAt: input.now(),
      });
      let settled = false;
      return {
        runInput: canonicalManagedAttachmentInput(claimInput.runInput, claimed.records),
        async commit() {
          if (settled) return;
          settled = true;
          commitReservations(reservations, claimInput.runId);
          await releasePendingRollbacks(claimInput.conversationId);
        },
        async rollback() {
          if (settled) return;
          settled = true;
          releaseReservations(reservations, claimInput.runId);
          scheduleRollback(claimInput.runId, claimInput.conversationId, claimed.newlyClaimedAttachmentIds);
          await releasePendingRollbacks(claimInput.conversationId);
        },
      };
    } catch (error) {
      releaseReservations(reservations, claimInput.runId);
      if (error instanceof OrdinaryManagedAttachmentRepositoryError && error.partialClaim !== undefined) {
        scheduleRollback(claimInput.runId, claimInput.conversationId, error.partialClaim.attachmentIds);
        await releasePendingRollbacks(claimInput.conversationId);
      }
      throw claimFeatureError(error);
    }
  }

  async function get(attachmentId: string): Promise<OrdinaryManagedAttachmentRecord | undefined> {
    try {
      return await configured().repository.get(attachmentId);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async function deleteConversation(conversationId: string): Promise<void> {
    if (input.repository === undefined) return;
    const records = await input.repository.list();
    for (const record of records) {
      if (record.owner.kind === "conversation" && record.owner.conversationId === conversationId) {
        await input.repository.delete(record.attachmentId, record.owner);
      }
    }
  }

  async function release(): Promise<void> {
    if (input.repository === undefined || input.instanceId === undefined) return;
    await releasePendingRollbacks();
    const records = await input.repository.list();
    for (const record of records) {
      if (record.owner.kind === "draft" && record.owner.instanceId === input.instanceId) {
        await input.repository.delete(record.attachmentId, record.owner);
      }
    }
    pendingRollbacks.clear();
  }

  function reservePendingRollbacks(
    conversationId: string,
    runId: string,
    attachmentIds: readonly string[],
  ): readonly ClaimReservation[] {
    const requested = new Set(attachmentIds);
    const reservations: ClaimReservation[] = [];
    for (const rollback of pendingRollbacks.values()) {
      if (rollback.conversationId !== conversationId || rollback.protectedByRunId !== undefined) continue;
      const protectedAttachmentIds = rollback.attachmentIds.filter((attachmentId) => requested.has(attachmentId));
      if (protectedAttachmentIds.length === 0) continue;
      pendingRollbacks.set(rollback.runId, { ...rollback, protectedByRunId: runId });
      reservations.push({ rollbackRunId: rollback.runId, protectedAttachmentIds });
    }
    return reservations;
  }

  function releaseReservations(reservations: readonly ClaimReservation[], runId: string): void {
    for (const reservation of reservations) {
      const rollback = pendingRollbacks.get(reservation.rollbackRunId);
      if (rollback?.protectedByRunId === runId) {
        pendingRollbacks.set(rollback.runId, { ...rollback, protectedByRunId: undefined });
      }
    }
  }

  function commitReservations(reservations: readonly ClaimReservation[], runId: string): void {
    for (const reservation of reservations) {
      const rollback = pendingRollbacks.get(reservation.rollbackRunId);
      if (rollback?.protectedByRunId !== runId) continue;
      const protectedIds = new Set(reservation.protectedAttachmentIds);
      const remaining = rollback.attachmentIds.filter((attachmentId) => !protectedIds.has(attachmentId));
      if (remaining.length === 0) pendingRollbacks.delete(rollback.runId);
      else pendingRollbacks.set(rollback.runId, {
        ...rollback,
        attachmentIds: remaining,
        protectedByRunId: undefined,
      });
    }
  }

  function scheduleRollback(runId: string, conversationId: string, attachmentIds: readonly string[]): void {
    if (attachmentIds.length === 0) return;
    pendingRollbacks.set(runId, { runId, conversationId, attachmentIds: [...attachmentIds] });
  }

  async function releasePendingRollbacks(conversationId?: string): Promise<void> {
    const configuration = configured();
    for (const rollback of [...pendingRollbacks.values()]) {
      if (rollback.protectedByRunId !== undefined ||
          (conversationId !== undefined && rollback.conversationId !== conversationId)) continue;
      try {
        await configuration.repository.releaseConversationClaim({
          attachmentIds: rollback.attachmentIds,
          instanceId: configuration.instanceId,
          conversationId: rollback.conversationId,
          releasedAt: input.now(),
        });
        if (pendingRollbacks.get(rollback.runId) === rollback) pendingRollbacks.delete(rollback.runId);
      } catch (error) {
        input.onRollbackFailure?.(rollback, error);
      }
    }
  }

  return { recover, createDraft, discardDraft, claimForRun, get, deleteConversation, release };
}

function settledClaim(runInput: OrdinaryRunInput): ManagedAttachmentRunClaim {
  return { runInput, async commit() {}, async rollback() {} };
}

export function managedAttachmentIds(input: OrdinaryRunInput): readonly string[] {
  return [...new Set((input.context?.contextRefs ?? []).flatMap((ref) => {
    const attachmentId = managedAttachmentId(ref.ref);
    return ref.kind === "file" && attachmentId !== undefined ? [attachmentId] : [];
  }))];
}

function canonicalManagedAttachmentInput(
  input: OrdinaryRunInput,
  records: readonly OrdinaryManagedAttachmentRecord[],
): OrdinaryRunInput {
  if (input.context === undefined || records.length === 0) return input;
  const byId = new Map(records.map((record) => [record.attachmentId, record] as const));
  const contextRefs = (input.context.contextRefs ?? []).map((ref) => {
    const attachmentId = managedAttachmentId(ref.ref);
    if (attachmentId === undefined) return ref;
    const record = byId.get(attachmentId);
    if (record === undefined) {
      throw new OrdinaryFeatureError(
        "ordinary_managed_attachment_unavailable",
        `Managed attachment ${attachmentId} was not claimed for this run.`,
      );
    }
    return {
      attachmentId: record.attachmentId,
      ref: managedAttachmentRef(record.attachmentId),
      kind: "file" as const,
      title: record.originalName,
      summary: `上传附件：${record.originalName} · ${record.byteLength} bytes`,
      metadata: {
        byteLength: record.byteLength,
        ...(record.mimeType === undefined ? {} : { mimeType: record.mimeType }),
        available: true,
        truncated: false,
      },
    };
  });
  return {
    ...input,
    context: {
      ...input.context,
      contextRefs,
      permissionBoundaryRefs: [
        ...(input.context.permissionBoundaryRefs ?? []).filter((ref) =>
          !isUploadedAttachmentReadPermission(ref)),
        ...records.map((record) => `read:uploaded-attachment:${record.attachmentId}`),
      ],
    },
  };
}

function isUploadedAttachmentReadPermission(value: string): boolean {
  const permission = parsePermissionBoundaryRef(value);
  if (permission?.kind !== "access" || permission.mode !== "read") return false;
  return parseContextReference(permission.target)?.scheme === "uploaded_attachment";
}

function attachmentFeatureError(error: unknown): unknown {
  if (error instanceof OrdinaryManagedAttachmentRepositoryError && (
    error.code === "ordinary_managed_attachment_ownership_conflict" ||
    error.code === "ordinary_managed_attachment_invalid_id" ||
    error.code === "ordinary_managed_attachment_invalid_input"
  )) {
    return new OrdinaryFeatureError("ordinary_managed_attachment_unavailable", error.message, { cause: error });
  }
  return error;
}

function claimFeatureError(error: unknown): unknown {
  if (error instanceof OrdinaryManagedAttachmentRepositoryError && (
    error.code === "ordinary_managed_attachment_not_found" ||
    error.code === "ordinary_managed_attachment_ownership_conflict" ||
    error.code === "ordinary_managed_attachment_invalid_id" ||
    error.code === "ordinary_managed_attachment_invalid_input"
  )) {
    return new OrdinaryFeatureError(
      "ordinary_managed_attachment_unavailable",
      "One or more uploaded attachments are unavailable or owned by another conversation.",
      { cause: error },
    );
  }
  return error;
}

function isNotFound(error: unknown): boolean {
  return error instanceof OrdinaryManagedAttachmentRepositoryError &&
    error.code === "ordinary_managed_attachment_not_found";
}
