import { redactSensitiveContent } from "../capture/maintenance-output.js";
import { memoryOwnerKey } from "../../../domain/memory/index.js";
import type { ConversationOwner } from "../../../domain/execution-scope/contracts.js";
import {
  MemoryError,
  type HistoryQueryPort,
  type MemoryAdminApplication,
  type MemoryBackgroundPort,
  type MemoryDiagnosticBinding,
  type MemoryDiagnosticContext,
  type MemoryDiagnosticJob,
  type MemoryDiagnosticQuery,
  type MemoryDiagnosticSearchInput,
  type MemoryDiagnosticSnapshot,
  type MemoryMaintenanceOutcomeTrace,
} from "../contracts.js";
import { MAINTENANCE_IDLE_DELAY_MS } from "../capture/capture-runtime.js";
import {
  MAINTENANCE_MAX_REQUEST_INPUT_TOKENS,
  MAINTENANCE_OUTPUT_RESERVE_TOKENS,
  MAINTENANCE_MEMORY_MAX_TOKENS,
  MAINTENANCE_SUMMARY_MAX_TOKENS,
} from "../policy/maintenance-limits.js";
import { resolveAdmissionFromPolicy } from "../policy/policy-snapshot.js";
import type { MemoryControlRepository } from "../store/control-repository.js";
import type { MemoryDocumentRepository } from "../store/content-repository.js";

export type DiagnosticConversationInfo = {
  readonly title: string;
  readonly owner: ConversationOwner;
  readonly active: boolean;
};

/** Narrow host-supplied Space owner lookup. Memory does not import Space or Workspace features. */
export type DiagnosticOwnerQuery = {
  readonly isOwnerAvailable: (owner: ConversationOwner) => Promise<boolean>;
  readonly getOwnerTitle: (owner: ConversationOwner) => Promise<string | undefined>;
};

/** Read-only inspection; never creates a binding, advances a cursor, or calls a model. */
export function createMemoryDiagnostics(input: {
  readonly control: MemoryControlRepository;
  readonly documents: MemoryDocumentRepository;
  readonly admin: MemoryAdminApplication;
  readonly background: MemoryBackgroundPort;
  readonly history: HistoryQueryPort;
  readonly getConversation: (id: string) => Promise<DiagnosticConversationInfo | undefined>;
  readonly getBinding: (id: string) => Promise<MemoryDiagnosticBinding | undefined>;
  readonly ownerQuery: DiagnosticOwnerQuery;
  readonly recentOutcomes: () => readonly MemoryMaintenanceOutcomeTrace[];
  readonly now?: () => number;
}) {
  const now = input.now ?? Date.now;

  async function resolveScope(query: MemoryDiagnosticQuery) {
    const conversation = query.conversationId === undefined
      ? undefined
      : await input.getConversation(query.conversationId);
    if (query.conversationId !== undefined && conversation === undefined) {
      throw new MemoryError("memory_invalid_owner", "该会话不存在或已删除。");
    }
    if (conversation !== undefined && query.owner !== undefined &&
        (conversation.owner.kind !== query.owner.kind || conversation.owner.id !== query.owner.id)) {
      throw new MemoryError("memory_invalid_owner", "该会话不属于所选 owner。");
    }

    const owner = query.owner ?? conversation?.owner;
    if (owner === undefined) return { conversation, owner, ownerTitle: undefined, ownerKey: undefined };
    if (!(await input.ownerQuery.isOwnerAvailable(owner))) {
      throw new MemoryError("memory_invalid_owner", "该 owner 不存在或已删除。");
    }
    const ownerTitle = await input.ownerQuery.getOwnerTitle(owner);
    if (ownerTitle === undefined) {
      throw new MemoryError("memory_invalid_owner", "该 owner 不存在或已删除。");
    }
    return { conversation, owner, ownerTitle, ownerKey: memoryOwnerKey(owner) };
  }

  return {
    async getSnapshot(query: MemoryDiagnosticQuery = {}): Promise<MemoryDiagnosticSnapshot> {
      const scope = await resolveScope(query);
      const at = now();
      const [jobs, policies, capability] = await Promise.all([
        input.control.readDiagnosticJobs({
          ownerKey: scope.ownerKey,
          conversationId: query.conversationId,
          limit: 30,
        }),
        input.control.readAllPolicy(),
        input.admin.getStatus(scope.owner === undefined ? {} : { owner: scope.owner }),
      ]);
      const infos = new Map<string, Promise<DiagnosticConversationInfo | undefined>>();
      const getInfo = (id: string) => {
        let info = infos.get(id);
        if (info === undefined) {
          info = input.getConversation(id);
          infos.set(id, info);
        }
        return info;
      };
      if (query.conversationId !== undefined) infos.set(query.conversationId, Promise.resolve(scope.conversation));
      const jobRows = await Promise.all(jobs.rows.map(async (job): Promise<MemoryDiagnosticJob> => {
        const [info, progress, ownerLifecycle, conversationLifecycle] = await Promise.all([
          getInfo(job.conversationId),
          input.documents.getProgress(job.conversationId),
          input.control.getLifecycle(job.ownerKey),
          input.control.getLifecycle(`conversation:${job.conversationId}`),
        ]);
        const admitted = info !== undefined && resolveAdmissionFromPolicy({
          owner: info.owner,
          conversationId: job.conversationId,
          policyRows: policies,
          ownerLifecycle,
          conversationLifecycle,
        }).effective !== "off";
        const waitReason = job.status !== "queued" ? null : !admitted ? "policy_blocked"
          : info?.active ? "active_conversation" : (job.nextAttemptAt ?? 0) > at ? "retry_backoff"
          : job.eligibleAt > at ? "idle_delay" : "ready";
        return {
          jobId: job.jobId,
          conversationId: job.conversationId,
          title: info?.title ?? "已删除或不可用的会话",
          ownerKey: job.ownerKey,
          status: job.status,
          waitReason,
          requestedThrough: job.requestedThroughOrdinal,
          processedThrough: progress?.processedThroughOrdinal ?? 0,
          excludedThrough: progress?.excludedThroughOrdinal ?? 0,
          fragment: progress?.processedFragmentOrdinal == null ? null
            : { ordinal: progress.processedFragmentOrdinal, end: progress.processedFragmentEnd ?? 0 },
          eligibleAt: job.eligibleAt,
          nextAttemptAt: job.nextAttemptAt,
          attempt: job.attempt,
          lastFailure: job.lastFailure === null ? null : redactSensitiveContent(job.lastFailure).slice(0, 2000),
          updatedAt: job.updatedAt,
        };
      }));

      let context: MemoryDiagnosticContext | null = null;
      if (scope.owner !== undefined && scope.ownerTitle !== undefined && scope.ownerKey !== undefined) {
        const owner = scope.owner;
        const [memory, summary, reference, ownerLifecycle, conversationLifecycle] = await Promise.all([
          input.documents.getActiveOwnerMemoryHead(scope.ownerKey),
          query.conversationId === undefined ? undefined : input.documents.getLatestValidSummary(query.conversationId),
          query.conversationId === undefined ? undefined : input.getBinding(query.conversationId),
          input.control.getLifecycle(scope.ownerKey),
          query.conversationId === undefined ? undefined : input.control.getLifecycle(`conversation:${query.conversationId}`),
        ]);
        const admission = resolveAdmissionFromPolicy({
          owner,
          conversationId: query.conversationId ?? "__diagnostics__",
          policyRows: policies,
          ownerLifecycle,
          conversationLifecycle,
        });
        const supplied = reference?.kind === "revision" ? await input.background.resolveSupplyableBackground({
          owner,
          revisionId: reference.revisionId,
          generation: reference.generation,
        }) : undefined;
        const currentSupply = memory === undefined ? undefined
          : supplied?.revisionId === memory.revisionId ? supplied
          : await input.background.resolveSupplyableBackground({
              owner, revisionId: memory.revisionId, generation: memory.generation,
            });
        context = {
          owner,
          ownerTitle: scope.ownerTitle,
          conversation: scope.conversation === undefined || query.conversationId === undefined ? null
            : { id: query.conversationId, title: scope.conversation.title, active: scope.conversation.active },
          capability,
          blockingReasons: admission.reasons,
          memory: memory === undefined ? null : {
            revisionId: memory.revisionId,
            revision: memory.revision,
            origin: memory.origin,
            markdown: memory.markdown,
            generation: memory.generation,
            updatedAt: memory.updatedAt,
            ...(currentSupply?.sourceStates === undefined ? {} : { sourceStates: currentSupply.sourceStates }),
          },
          summary: summary === undefined ? null : {
            revision: summary.revision,
            markdown: summary.markdown,
            updatedAt: summary.updatedAt,
            coveredThroughOrdinal: summary.coveredThroughOrdinal,
          },
          binding: query.conversationId === undefined ? null : {
            state: reference === undefined ? "unbound" : reference.kind === "none" ? "none" : supplied === undefined ? "unavailable" : "available",
            reference: reference ?? null,
            differsFromHead: reference?.kind === "revision" && reference.revisionId !== memory?.revisionId,
            markdown: supplied?.markdown ?? null,
          },
        };
      }
      return {
        enabled: true,
        generatedAt: at,
        capability,
        jobs: jobs.counts,
        jobRows,
        jobRowsTruncated: jobs.truncated,
        context,
        recentOutcomes: input.recentOutcomes().filter((entry) =>
          (scope.ownerKey === undefined || entry.ownerKey === scope.ownerKey) &&
          (query.conversationId === undefined || entry.conversationId === query.conversationId),
        ).slice(0, 50).map((entry) => ({
          ...entry,
          ...(entry.reason === undefined ? {} : { reason: redactSensitiveContent(entry.reason).slice(0, 2000) }),
        })),
        limits: {
          idleDelayMs: MAINTENANCE_IDLE_DELAY_MS,
          requestTokens: MAINTENANCE_MAX_REQUEST_INPUT_TOKENS,
          outputReserveTokens: MAINTENANCE_OUTPUT_RESERVE_TOKENS,
          memoryTokens: MAINTENANCE_MEMORY_MAX_TOKENS,
          summaryTokens: MAINTENANCE_SUMMARY_MAX_TOKENS,
        },
      };
    },

    async searchHistory(search: MemoryDiagnosticSearchInput) {
      await resolveScope(search);
      return await input.history.search({
        owner: search.owner,
        query: search.query,
        conversationId: search.conversationId,
        sources: search.source,
        limit: 8,
      });
    },
  };
}
