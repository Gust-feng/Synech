import { memoryOwnerKey, type MemoryOwner } from "../../../domain/memory/index.js";
import type { SpaceAdmission } from "../../ownership/admission.js";
import {
  MemoryError,
  type ClearMemoryResult,
  type MemoryAdminApplication,
  type MemoryCapabilityQuery,
  type MemoryCapabilityStatus,
  type MemoryLifecycle,
  type MemoryRolloutMode,
  type MemoryRuntimeHealth,
  type OwnerMemoryBackground,
  type PolicyRevision,
} from "../contracts.js";
import { MAINTENANCE_MEMORY_MAX_TOKENS } from "../policy/maintenance-limits.js";
import { countMemoryTokens } from "../token-counting.js";
import type { MemoryDocumentRepository } from "../store/content-repository.js";
import type { UpdateMemoryEntryInput } from "../entry-contracts.js";
import { z } from "zod";
import type { MemoryControlRepository } from "../store/control-repository.js";
import type { MemoryPolicyRow } from "../store/persistence-schema.js";
import { POLICY_KEY, resolveAdmissionFromPolicy } from "../policy/policy-snapshot.js";

/** Owner 存在性只读端口，由 Composition Root 注入对应 Feature 的 queries。 */
export type MemoryOwnerExistsQuery = {
  /** 返回 true 表示 owner 仍存在且未在删除流程中。 */
  readonly isSpaceAvailable: (spaceId: string) => Promise<boolean>;
};

/** Runtime health 派生端口；健康是运行投影，不回写用户策略。 */
export type MemoryRuntimeHealthQuery = {
  readonly read: () => Promise<MemoryRuntimeHealth>;
};

/**
 * Conversation ordinal 高水位端口（Ordinary 窄查询）：返回每个会话已分配的
 * ordinal 高水位（含排队与未稳定运行）。清除与启用边界据此写 excludedThrough，
 * 防止 queued backlog 与关闭区间被回填（正式设计 §11.2/§11.3）。
 */
export type ConversationHighWaterQuery = {
  readonly listConversationHighWaters: () => Promise<
    readonly {
      readonly conversationId: string;
      readonly ownerKey: string;
      readonly allocatedThroughOrdinal: number;
    }[]
  >;
};

/**
 * 会话只读信息端口（N05）：由 Composition Root 注入 Ordinary 只读查询，
 * 把来源会话从裸 ID 变成用户可识别的标题与来源时间。
 */
export type ConversationInfoQuery = {
  readonly getConversationInfo: (conversationId: string) => Promise<{
    readonly title: string;
    readonly updatedAt: string;
  } | undefined>;
};

export type CreateMemoryAdminApplicationInput = {
  readonly controlRepository: MemoryControlRepository;
  readonly documentRepository: MemoryDocumentRepository;
  readonly lifecycle: MemoryLifecycle;
  readonly spaceAdmission: SpaceAdmission;
  readonly ownerExistsQuery: MemoryOwnerExistsQuery;
  readonly conversationHighWaterQuery: ConversationHighWaterQuery;
  readonly conversationInfoQuery?: ConversationInfoQuery;
  readonly runtimeHealth?: MemoryRuntimeHealthQuery;
  readonly now?: () => number;
};

/**
 * 解析 owner 是否仍存在且可被写入；fence/tombstone 一律视为不存在
 * （fail-closed，防止删除中的 owner 重新出现记忆事实）。
 */
async function assertOwnerAvailable(
  ownerExistsQuery: MemoryOwnerExistsQuery,
  owner: MemoryOwner,
): Promise<void> {
  if (owner.kind === "space") {
    const available = await ownerExistsQuery.isSpaceAvailable(owner.id);
    if (!available) {
      throw new MemoryError("memory_owner_deleted", `Space ${owner.id} is unavailable for memory.`);
    }
    return;
  }
  // global scope 没有 owner admission，直接放行。
}

/** 结构化 owner 走对应 admission；global 没有 owner admission，直接执行。 */
async function admitOwner<TResult>(
  admissions: {
    readonly spaceAdmission: SpaceAdmission;
  },
  owner: MemoryOwner,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  if (owner.kind === "space") return await admissions.spaceAdmission.admit(owner.id, operation);
  return await operation();
}

/**
 * 只有 document owner（Space）拥有长期文档。
 * global 只是用户开关与全局清除范围，不保存文档。
 */
function assertDocumentOwner(owner: MemoryOwner): void {
  if (owner.kind === "space") return;
  throw new MemoryError(
    "memory_invalid_owner",
    "Global memory is a switch and a clear scope only; it never stores a long-term document.",
  );
}

function rolloutOf(policyRows: readonly MemoryPolicyRow[]): MemoryRolloutMode {
  const rolloutRow = policyRows.find((row) => row.key === POLICY_KEY.rollout);
  if (rolloutRow === undefined || !rolloutRow.enabled) return "off";
  return rolloutRow.scopeOwnerKey === "shadow" || rolloutRow.scopeOwnerKey === "active"
    ? rolloutRow.scopeOwnerKey
    : "off";
}

const identity = z.string().trim().min(1).max(256);
const editContent = {
  entryId: identity,
  markdown: z.string(),
  applicability: z.string().min(1).nullable(),
  occurredAt: z.string().min(1).nullable(),
  reason: z.string().min(1).nullable(),
  topicIds: z.array(identity).max(4),
  related: z.array(z.object({ entryId: identity, sourceIds: z.array(identity).min(1) }).strict()).max(3),
};
/** Parsed at the application boundary; UI cannot submit source locators or host timestamps. */
export const updateMemoryEntrySchema = z.object({
  owner: z.object({ kind: z.literal("space"), id: identity }).strict(),
  requestId: identity,
  edit: z.discriminatedUnion("operation", [
    z.object({ ...editContent, operation: z.literal("create"), expectedRevisionId: z.null(),
      kind: z.literal("initial"), retractsRevisionIds: z.tuple([]) }).strict(),
    z.object({ ...editContent, operation: z.literal("revise"), expectedRevisionId: identity,
      kind: z.enum(["supplement", "change", "correction", "withdrawal"]), retractsRevisionIds: z.array(identity) }).strict(),
  ]),
}).strict().superRefine(({ edit }, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", path: ["edit"], message });
  if (edit.kind !== "withdrawal" && edit.markdown.trim() === "") issue("Only withdrawal can have empty content.");
  const retracting = edit.kind === "correction" || edit.kind === "withdrawal";
  if (retracting !== (edit.retractsRevisionIds.length > 0)) issue("Correction and withdrawal require explicit affected revisions.");
  if (new Set(edit.retractsRevisionIds).size !== edit.retractsRevisionIds.length) issue("Duplicate affected revisions.");
  if (edit.related.some(link => link.entryId === edit.entryId)) issue("An entry cannot relate to itself.");
});

export function createMemoryAdminApplication(
  input: CreateMemoryAdminApplicationInput,
): MemoryAdminApplication {
  const controlRepository = input.controlRepository;
  const documentRepository = input.documentRepository;
  const lifecycle = input.lifecycle;
  const spaceAdmission = input.spaceAdmission;
  const ownerExistsQuery = input.ownerExistsQuery;
  const highWaterQuery = input.conversationHighWaterQuery;
  const now = input.now ?? Date.now;
  const countTokens = countMemoryTokens;

  /**
   * 启用/清除边界的排除高水位。Space 同源处理；
   * global scope 覆盖两类 document owner 的全部会话。
   * 写入本身取 max（只进不退），因此同值重写不改变边界。
   */
  const writeExclusionsForScope = async (scope: MemoryOwner): Promise<void> => {
    const highWaters = await highWaterQuery.listConversationHighWaters();
    const scopeKey = scope.kind === "global" ? null : memoryOwnerKey(scope);
    const at = now();
    for (const entry of highWaters) {
      // 只有 document owner（Space）拥有排除边界。
      if (!entry.ownerKey.startsWith("space:")) continue;
      if (scopeKey !== null && entry.ownerKey !== scopeKey) continue;
      await documentRepository.setExcludedThrough({
        conversationId: entry.conversationId,
        ownerKey: entry.ownerKey,
        excludedThroughOrdinal: entry.allocatedThroughOrdinal,
        now: at,
      });
    }
  };

  const readPolicyRevision = async (query: {
    readonly owner?: MemoryOwner;
  } = {}): Promise<PolicyRevision> => {
    const policyRows = await controlRepository.readAllPolicy();
    const owner = query.owner ?? { kind: "global" };
    const ownerKey = memoryOwnerKey(owner);
    const ownerLifecycle = await controlRepository.getLifecycle(ownerKey);
    return resolveAdmissionFromPolicy({
      owner,
      conversationId: "__admin__",
      policyRows,
      ownerLifecycle,
      conversationLifecycle: undefined,
    }).policyRevision;
  };

  return {
    async getStatus(query: MemoryCapabilityQuery = {}): Promise<MemoryCapabilityStatus> {
      const owner = query.owner ?? { kind: "global" };
      const policyRows = await controlRepository.readAllPolicy();
      const ownerKey = memoryOwnerKey(owner);
      const ownerLifecycle = await controlRepository.getLifecycle(ownerKey);
      const health = input.runtimeHealth === undefined ? "ready" : await input.runtimeHealth.read();
      // Space 同源：两类 owner 都只由全局 enabled 开关决定，
      // hasContent 只投影已发布内容，不参与授权判断。
      const admission = resolveAdmissionFromPolicy({
        owner,
        conversationId: "__capability_status__",
        policyRows,
        ownerLifecycle,
        conversationLifecycle: undefined,
      });
      return {
        hasContent: await documentRepository.hasContent(owner.kind === "global" ? undefined : ownerKey),
        enabled: policyRows.find((row) => row.key === POLICY_KEY.consent)?.enabled ?? false,
        rollout: rolloutOf(policyRows),
        health,
        effective: admission.effective,
      };
    },

    async setRollout({ rollout }: { rollout: MemoryRolloutMode }) {
      const policyRows = await controlRepository.readAllPolicy();
      const existing = policyRows.find((row) => row.key === POLICY_KEY.rollout);
      const previousMode = existing?.enabled === true && (existing.scopeOwnerKey === "shadow" || existing.scopeOwnerKey === "active")
        ? existing.scopeOwnerKey
        : "off";
      if (previousMode === "off" && rollout !== "off") {
        // R09：从 off 重新启用（active 或 shadow）与启用开关同一资格边界
        // ——关闭期间不推进进度，必须按高水位排除，不得回填。
        // 与 setEnabled 同序：先在仍关闭时写排除边界，再 CAS 发布新 rollout。
        // active↔shadow 之间的切换不排除（shadow 期间正常整理）。
        await writeExclusionsForScope({ kind: "global" });
      }
      await controlRepository.setPolicy({
        key: POLICY_KEY.rollout,
        kind: "rollout",
        // A disabled row is the durable `off` state. Keeping the requested
        // mode in the row retains a coherent revision history without schema.
        scopeOwnerKey: rollout,
        enabled: rollout !== "off",
        // 始终传 expectedRevision（无行时为 0）：CAS 在行首次创建后同样生效，
        // 并发的 clear/启用不会互相覆盖。
        expectedRevision: existing?.revision ?? 0,
      });
      return { policyRevision: await readPolicyRevision() };
    },

    async setEnabled({ enabled }) {
      // 全局开关不受 owner admission 约束；当前 policy 行就是权威，
      // 经 setPolicy CAS（expectedRevision 等于已读 revision）写。与 clear 交错时，
      // 读写之间的 revision 变化使 CAS 失败，启用不会覆盖在途清除的新边界。
      const policyRows = await controlRepository.readAllPolicy();
      const existing = policyRows.find((row) => row.key === POLICY_KEY.consent);
      const current = existing?.enabled ?? false;
      if (current === enabled) {
        // 同值幂等：不重写行、不 bump revision、不重复排除——否则会毫无侧重地使在途整理结果失效。
        return { policyRevision: await readPolicyRevision() };
      }
      if (enabled) {
        // 先在仍关闭时写入 Space 的高水位排除边界，再 CAS 开启。
        // 因此排除期间 capture/commit 仍被关闭策略阻断；只要 CAS 成功，启用前
        // 所有已分配 ordinal 已经被排除，queued/未稳定内容不能回填。
        await writeExclusionsForScope({ kind: "global" });
      }
      await controlRepository.setPolicy({
        key: POLICY_KEY.consent,
        kind: "global_consent",
        scopeOwnerKey: null,
        enabled,
        // 始终传 expectedRevision（无行时为 0）：CAS 在行首次创建后同样生效，
        // 并发的 clear/启用不会互相覆盖。
        expectedRevision: existing?.revision ?? 0,
      });
      return { policyRevision: await readPolicyRevision() };
    },

    async clearMemory({ scope }): Promise<ClearMemoryResult> {
      // 清除工作流：高水位排除 → fence → purge（保留排除边界）→ 可继续参与。
      // 不改变用户 enabled，也不让清除前历史在重新开启后被回填。
      const clear = async (): Promise<ClearMemoryResult> => {
        await assertOwnerAvailable(ownerExistsQuery, scope);
        // 1. admission 边界内取高水位并先持久化排除边界（§11.3 顺序）。
        await writeExclusionsForScope(scope);
        if (scope.kind === "global") {
          // Global clear invalidates every in-flight capture without changing
          // consent: the same policy row is CAS-written with a new revision.
          const policyRows = await controlRepository.readAllPolicy();
          const consent = policyRows.find((row) => row.key === POLICY_KEY.consent);
          await controlRepository.setPolicy({
            key: POLICY_KEY.consent,
            kind: "global_consent",
            scopeOwnerKey: null,
            enabled: consent?.enabled ?? false,
            expectedRevision: consent?.revision ?? 0,
          });
        }
        // 2. fence → purge（保留排除边界）→ 恢复参与。
        return await lifecycle.clearOwnerMemory(scope);
      };
      return await admitOwner({ spaceAdmission }, scope, clear);
    },

    async updateMemory(rawInput) {
      const parsed = updateMemoryEntrySchema.safeParse(rawInput);
      if (!parsed.success) throw new MemoryError("memory_invalid_edit", parsed.error.message);
      const command: UpdateMemoryEntryInput = parsed.data;
      const { owner, edit } = command;
      assertDocumentOwner(owner);
      if (countTokens(JSON.stringify(edit)) > MAINTENANCE_MEMORY_MAX_TOKENS) {
        throw new MemoryError("memory_capacity_exceeded", `Memory edit exceeds ${MAINTENANCE_MEMORY_MAX_TOKENS} tokens.`);
      }
      return await admitOwner({ spaceAdmission }, owner, async () => {
        await assertOwnerAvailable(ownerExistsQuery, owner);
        const state = await controlRepository.getLifecycle(memoryOwnerKey(owner));
        // The repository rechecks generation/fence, CAS and payload idempotency atomically.
        // User provenance and reported/published times are created there, never accepted from UI.
        return await documentRepository.recordUserMemoryEdit({
          ...command, expectedGeneration: state?.generation ?? 0, now: now(),
        });
      });
    },

    async getMemoryView({ owner, entryId, limit = 20, cursor }) {
      assertDocumentOwner(owner);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50 || entryId === "" || cursor === "") {
        throw new MemoryError("memory_invalid_edit", "Invalid memory page parameters.");
      }
      return await admitOwner({ spaceAdmission }, owner, async () => {
        await assertOwnerAvailable(ownerExistsQuery, owner);
        const ownerKey = memoryOwnerKey(owner);
        const [head, topics, stats] = await Promise.all([
          documentRepository.getActiveOwnerMemoryHead(ownerKey),
          documentRepository.listTopics(ownerKey),
          documentRepository.getOwnerViewStats(ownerKey),
        ]);
        let page;
        if (entryId === undefined) {
          page = await documentRepository.listEntries({ ownerKey, limit, ...(cursor === undefined ? {} : { cursor }) });
        } else {
          if (await documentRepository.getEntry({ ownerKey, entryId }) === undefined) {
            throw new MemoryError("memory_entry_not_found", "Memory entry is unavailable in this owner.");
          }
          const revisions = await documentRepository.listEntryRevisions({ ownerKey, entryId, limit, ...(cursor === undefined ? {} : { cursor }) });
          const entries = await Promise.all(revisions.revisions.map(ref =>
            documentRepository.getEntryRevision({ ownerKey, entryId, revisionId: ref.revisionId })));
          page = { entries: entries.filter(item => item !== undefined), nextCursor: revisions.nextCursor };
        }
        const document: OwnerMemoryBackground | undefined = head === undefined ? undefined : {
          revisionId: head.revisionId, revision: head.revision, origin: head.origin,
          markdown: head.markdown, generation: head.generation, updatedAt: head.updatedAt,
        };
        return { document, entries: page.entries, topics, nextCursor: page.nextCursor, ...stats };
      });
    },
  };
}
