import { memoryOwnerKey, type MemoryOwner } from "../../../domain/memory/index.js";
import type { SpaceAdmission } from "../../ownership/admission.js";
import {
  MemoryError,
  type ClearImplicitMemoryResult,
  type MemoryAdminApplication,
  type MemoryCapabilityQuery,
  type MemoryCapabilityStatus,
  type MemoryLifecycle,
  type MemoryRolloutMode,
  type MemoryRuntimeHealth,
  type PolicyRevision,
  type SpaceMemoryBackground,
  type WriteSpaceMemoryResult,
} from "../contracts.js";
import { MAINTENANCE_MEMORY_MAX_TOKENS, defaultCountTokens } from "../capture/consolidation.js";
import type { MemoryDocumentRepository } from "../store/content-repository.js";
import type { MemoryControlRepository } from "../store/control-repository.js";
import {
  POLICY_KEY,
  spaceParticipationKey,
  resolveAdmissionFromPolicy,
} from "../policy/policy-snapshot.js";

/** Owner 存在性只读端口，由 Composition Root 注入对应 Feature 的 queries。 */
export type MemoryOwnerExistsQuery = {
  /** 返回 true 表示 owner 仍存在且未在删除流程中。 */
  readonly isSpaceAvailable: (spaceId: string) => Promise<boolean>;
  /** 返回 true 表示 workspace 仍存在且未在删除流程中。 */
  readonly isWorkspaceAvailable: (workspaceId: string) => Promise<boolean>;
};

/** Runtime health 派生端口；健康是运行投影，不回写用户策略。 */
export type MemoryRuntimeHealthQuery = {
  readonly read: () => Promise<MemoryRuntimeHealth>;
};

/**
 * Conversation ordinal 高水位端口（Ordinary 窄查询）：返回每个会话已分配的
 * ordinal 高水位（含排队与未稳定运行）。clear 与启用边界据此写 excludedThrough，
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
  /** Workspace owner admission, shared with the workspace deletion coordinator. */
  readonly workspaceAdmission: Pick<SpaceAdmission, "admit">;
  readonly ownerExistsQuery: MemoryOwnerExistsQuery;
  readonly conversationHighWaterQuery: ConversationHighWaterQuery;
  readonly conversationInfoQuery?: ConversationInfoQuery;
  readonly runtimeHealth?: MemoryRuntimeHealthQuery;
  readonly now?: () => number;
};

/**
 * 解析 owner 是否仍存在且可被 participation 写入；fence/tombstone 一律视为不存在
 * （fail-closed，防止删除中的 owner 重新出现 participation 事实）。
 */
async function assertOwnerAvailable(
  ownerExistsQuery: MemoryOwnerExistsQuery,
  owner: MemoryOwner,
): Promise<void> {
  if (owner.kind === "space") {
    const available = await ownerExistsQuery.isSpaceAvailable(owner.id);
    if (!available) {
      throw new MemoryError("memory_owner_deleted", `Space ${owner.id} is unavailable for participation.`);
    }
    return;
  }
  if (owner.kind === "workspace") {
    const available = await ownerExistsQuery.isWorkspaceAvailable(owner.id);
    if (!available) {
      throw new MemoryError("memory_owner_deleted", `Workspace ${owner.id} is unavailable for participation.`);
    }
    return;
  }
  // global scope 没有 owner admission，直接放行。
}

export function createMemoryAdminApplication(
  input: CreateMemoryAdminApplicationInput,
): MemoryAdminApplication {
  const controlRepository = input.controlRepository;
  const documentRepository = input.documentRepository;
  const lifecycle = input.lifecycle;
  const spaceAdmission = input.spaceAdmission;
  const workspaceAdmission = input.workspaceAdmission;
  const ownerExistsQuery = input.ownerExistsQuery;
  const highWaterQuery = input.conversationHighWaterQuery;
  const now = input.now ?? Date.now;
  const countTokens = defaultCountTokens;

  /** 启用/清除边界的排除高水位：把范围内全部 Space 会话的已分配 ordinal 排除。 */
  const writeExclusionsForScope = async (scope: MemoryOwner): Promise<void> => {
    const highWaters = await highWaterQuery.listConversationHighWaters();
    const ownerPrefix = scope.kind === "space" ? `space:${scope.id}` : null;
    const at = now();
    for (const entry of highWaters) {
      // Memory 首版只参与 Space scope；workspace 会话没有排除边界可写。
      if (!entry.ownerKey.startsWith("space:")) continue;
      if (ownerPrefix !== null && entry.ownerKey !== ownerPrefix) continue;
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
    async getCapabilityStatus(query: MemoryCapabilityQuery = {}): Promise<MemoryCapabilityStatus> {
      const owner = query.owner ?? { kind: "global" };
      const policyRows = await controlRepository.readAllPolicy();
      const ownerKey = memoryOwnerKey(owner);
      const ownerLifecycle = await controlRepository.getLifecycle(ownerKey);
      const health = input.runtimeHealth === undefined ? "ready" : await input.runtimeHealth.read();
      // 只有 Space 可以参与自动记忆；全局视图只报告总闸门，Workspace 视图恒为 off。
      const admission = resolveAdmissionFromPolicy({
        owner,
        conversationId: "__capability_status__",
        policyRows,
        ownerLifecycle,
        conversationLifecycle: undefined,
      });
      const spaceParticipation = owner.kind === "space"
        ? policyRows.find((row) => row.key === spaceParticipationKey(owner.id))?.enabled ?? false
        : undefined;
      return {
        globalConsent: policyRows.find((row) => row.key === POLICY_KEY.consent)?.enabled ?? false,
        rollout: (() => {
          const rolloutRow = policyRows.find((row) => row.key === POLICY_KEY.rollout);
          if (rolloutRow === undefined || !rolloutRow.enabled) return "off";
          return rolloutRow.scopeOwnerKey === "shadow" || rolloutRow.scopeOwnerKey === "active"
            ? rolloutRow.scopeOwnerKey
            : "off";
        })(),
        health,
        effective: admission.effective,
        ...(spaceParticipation === undefined ? {} : { spaceParticipation }),
      };
    },

    async setRollout({ rollout }: { rollout: MemoryRolloutMode }) {
      const policyRows = await controlRepository.readAllPolicy();
      const existing = policyRows.find((row) => row.key === POLICY_KEY.rollout);
      const previousMode = existing?.enabled === true && (existing.scopeOwnerKey === "shadow" || existing.scopeOwnerKey === "active")
        ? existing.scopeOwnerKey
        : "off";
      await controlRepository.setPolicy({
        key: POLICY_KEY.rollout,
        kind: "rollout",
        // A disabled row is the durable `off` state. Keeping the requested
        // mode in the row retains a coherent revision history without schema.
        scopeOwnerKey: rollout,
        enabled: rollout !== "off",
        ...(existing === undefined ? {} : { expectedRevision: existing.revision }),
      });
      if (previousMode === "off" && rollout !== "off") {
        // R09：从 off 重新启用（active 或 shadow）与 consent/participation 启用
        // 同一资格边界——关闭期间不推进进度，必须按高水位排除，不得回填。
        // active↔shadow 之间的切换不排除（shadow 期间正常整理）。
        await writeExclusionsForScope({ kind: "global" });
      }
      return { policyRevision: await readPolicyRevision() };
    },

    async setConsent({ globalConsent }) {
      // global consent 不受 owner admission 约束：当前 policy 行就是权威，
      // 经 setPolicy CAS（expectedRevision 等于已读 revision）写。
      const policyRows = await controlRepository.readAllPolicy();
      const existing = policyRows.find((row) => row.key === POLICY_KEY.consent);
      await controlRepository.setPolicy({
        key: POLICY_KEY.consent,
        kind: "global_consent",
        scopeOwnerKey: null,
        enabled: globalConsent,
        ...(existing === undefined ? {} : { expectedRevision: existing.revision }),
      });
      if (globalConsent) {
        // 首次启用/重新启用：排除启用前的全部已分配范围（含关闭区间与未稳定运行），
        // 重新开启不回填（正式设计 §11.2）。
        await writeExclusionsForScope({ kind: "global" });
      }
      return { policyRevision: await readPolicyRevision() };
    },

    async setSpaceParticipation({ spaceId, enabled }) {
      // SpaceAdmission 锁内：admit 期间同一 spaceId 的删除 workflow 必须串行
      // （workbench-coordination-runtime 的 withSpaceAdmission 模式），在 admit
      // 内重读 space 仍存在才允许写 participation（手册 6.5）。
      return await spaceAdmission.admit(spaceId, async () => {
        const available = await ownerExistsQuery.isSpaceAvailable(spaceId);
        if (!available) {
          throw new MemoryError("memory_owner_deleted", `Space ${spaceId} is unavailable for participation.`);
        }
        const ownerKey = memoryOwnerKey({ kind: "space", id: spaceId });
        const policyRows = await controlRepository.readAllPolicy();
        const existing = policyRows.find((row) => row.key === spaceParticipationKey(spaceId));
        await controlRepository.setPolicy({
          key: spaceParticipationKey(spaceId),
          kind: "space_participation",
          scopeOwnerKey: ownerKey,
          enabled,
          ...(existing === undefined ? {} : { expectedRevision: existing.revision }),
        });
        if (enabled) {
          await writeExclusionsForScope({ kind: "space", id: spaceId });
        }
        return { policyRevision: await readPolicyRevision({ owner: { kind: "space", id: spaceId } }) };
      });
    },

    async clearImplicitMemory({ scope }): Promise<ClearImplicitMemoryResult> {
      // 清除是 Memory Feature 内部的「高水位排除 → fence → purge → 可继续参与」
      // 工作流：不改变用户 consent/participation，也不让清除前历史在重新开启后被回填。
      const clear = async (): Promise<ClearImplicitMemoryResult> => {
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
            ...(consent === undefined ? {} : { expectedRevision: consent.revision }),
          });
        }
        // 2. fence → purge（保留排除边界）→ 恢复参与。
        return await lifecycle.clearOwnerMemory(scope);
      };
      if (scope.kind === "space") return await spaceAdmission.admit(scope.id, clear);
      if (scope.kind === "workspace") return await workspaceAdmission.admit(scope.id, clear);
      return await clear();
    },

    async writeSpaceMemory({ spaceId, expectedRevisionId, markdown, requestId }): Promise<WriteSpaceMemoryResult> {
      // 用户直接编辑是唯一无需新证据的编辑路径：不调用模型、不等 worker；
      // capacity 与 CAS 由宿主校验，fenced owner 拒绝编辑。
      if (countTokens(markdown) > MAINTENANCE_MEMORY_MAX_TOKENS) {
        throw new MemoryError(
          "memory_capacity_exceeded",
          `Space memory edit exceeds the ${MAINTENANCE_MEMORY_MAX_TOKENS} token hard cap.`,
        );
      }
      return await spaceAdmission.admit(spaceId, async () => {
        const available = await ownerExistsQuery.isSpaceAvailable(spaceId);
        if (!available) {
          throw new MemoryError("memory_owner_deleted", `Space ${spaceId} is unavailable for memory editing.`);
        }
        const ownerKey = memoryOwnerKey({ kind: "space", id: spaceId });
        const row = await documentRepository.recordUserSpaceMemoryEdit({
          ownerKey,
          markdown,
          requestId,
          expectedRevisionId,
          now: now(),
        });
        return { revisionId: row.revisionId, revision: row.revision };
      });
    },

    async getSpaceMemoryView({ spaceId }) {
      const ownerKey = memoryOwnerKey({ kind: "space", id: spaceId });
      const head = await documentRepository.getActiveSpaceMemoryHead(ownerKey);
      // R15：把数据库中已有的来源关系暴露给用户——来源会话与范围按会话聚合，
      // 文档级保守依赖粒度如实展示，不调用模型生成事后解释。
      const sources = head === undefined
        ? []
        : (await documentRepository.listSpaceDocSources(head.revisionId))
            .filter((source) => source.depKind === "conversation_range" && source.conversationId !== null)
            .map((source) => ({
              conversationId: source.conversationId as string,
              fromOrdinal: source.fromOrdinal ?? 0,
              toOrdinal: source.toOrdinal ?? 0,
            }));
      const aggregated = new Map<string, { conversationId: string; fromOrdinal: number; toOrdinal: number }>();
      for (const source of sources) {
        const existing = aggregated.get(source.conversationId);
        if (existing === undefined) {
          aggregated.set(source.conversationId, { ...source });
          continue;
        }
        existing.fromOrdinal = Math.min(existing.fromOrdinal, source.fromOrdinal);
        existing.toOrdinal = Math.max(existing.toOrdinal, source.toOrdinal);
      }
      const infoQuery = input.conversationInfoQuery;
      const viewSources = [];
      for (const entry of [...aggregated.values()].sort((left, right) => left.conversationId.localeCompare(right.conversationId))) {
        const info = infoQuery === undefined ? undefined : await infoQuery.getConversationInfo(entry.conversationId);
        viewSources.push({
          ...entry,
          ...(info === undefined ? {} : { title: info.title, sourceTime: info.updatedAt }),
        });
      }
      const stats = await documentRepository.getSpaceViewStats(ownerKey);
      const document: SpaceMemoryBackground | undefined = head === undefined ? undefined : {
        revisionId: head.revisionId,
        revision: head.revision,
        origin: head.origin,
        markdown: head.markdown,
        generation: head.generation,
        updatedAt: head.updatedAt,
      };
      return {
        document,
        sources: viewSources,
        summaryCount: stats.summaryCount,
        lastMaintenanceAt: stats.lastMaintenanceAt,
      };
    },
  };
}
