/**
 * Memory Admin Application（《手册》6.5）：普通设置命令的统一入口，
 * 五个命令都是用户可见功能的单一 mutation 边界。
 *
 * 不变量：
 * - setConsent 直接走 controlRepository.setPolicy CAS（POLICY_KEY.consent +
 *   kind=global_consent），不需 admission（用户自身的全局开关不受 owner admission
 *   影响）。全局开关关闭期间已开启的 Space participation 不会被清空；
 * - setSpaceParticipation / setConversationParticipation 必须先经 owner admission
 *   在锁内重读 owner/conversation 当前状态，确认未被 fence/tombstone 才允许写
 *   participation policy；防止删除中的 owner 重新出现 participation 事实；
 * - clearImplicitMemory 是单个 destructive 命令（不向外暴露两阶段）：在 owner
 *   admission 内由 lifecycle 完成 generation fence、派生内容 purge，再恢复为可
 *   继续参与的状态；不通过 WorkbenchCoordination，也不改变用户开关；
 * - getCapabilityStatus 重算 effective admission（global scope）并报告当前
 *   rollout / health 派生事实，不缓存（手册 7.1）。
 *
 * Application 不 import panel-server / workspaces / personal-knowledge；owner
 * 存在性/admission 由 Composition Root 注入的 read-model/admission 端口承担，
 * Memory 内部再决定 policy 写路径。
 */

import { memoryOwnerKey, type MemoryOwner } from "../../../domain/memory/index.js";
import type { ConversationOwner } from "../../../domain/execution-scope/index.js";
import type { SpaceAdmission } from "../../ownership/admission.js";
import {
  MemoryError,
  type ClearImplicitMemoryResult,
  type MemoryAdminApplication,
  type MemoryCapabilityQuery,
  type MemoryCapabilityStatus,
  type MemoryRuntimeHealth,
  type PolicyRevision,
} from "../contracts.js";
import type { MemoryContentRepository } from "../store/content-repository.js";
import type { MemoryControlRepository } from "../store/control-repository.js";
import type { MemoryLifecycle } from "../contracts.js";
import {
  POLICY_KEY,
  conversationExclusionKey,
  participationKey,
  resolveAdmissionFromPolicy,
} from "../policy/policy-snapshot.js";

/**
 * Owner / Conversation 存在性只读端口，由 Composition Root 注入对应 Feature
 * 的 queries.getTree / conversation-control-repo.get 等；Memory Admin 不直连
 * Space / Ordinary Repository。
 */
export type MemoryOwnerExistsQuery = {
  /** 返回 true 表示 owner 仍存在且未在删除流程中。 */
  readonly isSpaceAvailable: (spaceId: string) => Promise<boolean>;
  /** 返回 true 表示 workspace 仍存在且未在删除流程中。 */
  readonly isWorkspaceAvailable: (workspaceId: string) => Promise<boolean>;
  /**
   Conversation 存在性 + owner 元数据，仅用于 participation 写前的 admission 复核。
   返回 undefined 表示 conversation 不存在或已删除。
   */
  readonly getConversationOwner:
    | ((conversationId: string) => Promise<{ readonly exists: boolean; readonly owner: ConversationOwner } | undefined>);
};

/** Runtime health 派生端口；健康是运行投影，不回写用户策略。 */
export type MemoryRuntimeHealthQuery = {
  readonly read: () => Promise<MemoryRuntimeHealth>;
};

export type CreateMemoryAdminApplicationInput = {
  readonly controlRepository: MemoryControlRepository;
  readonly lifecycle: MemoryLifecycle;
  /** 由 lifecycle 在 fence 后清理派生 Record/Source/Index/Job。 */
  readonly contentRepository: MemoryContentRepository;
  readonly spaceAdmission: SpaceAdmission;
  /** Workspace owner admission, shared with the workspace deletion coordinator. */
  readonly workspaceAdmission: Pick<SpaceAdmission, "admit">;
  /** Conversation admission, shared with the conversation deletion coordinator. */
  readonly conversationAdmission: Pick<SpaceAdmission, "admit">;
  readonly ownerExistsQuery: MemoryOwnerExistsQuery;
  readonly runtimeHealth?: MemoryRuntimeHealthQuery;
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
  const lifecycle = input.lifecycle;
  const spaceAdmission = input.spaceAdmission;
  const workspaceAdmission = input.workspaceAdmission;
  const conversationAdmission = input.conversationAdmission;
  const ownerExistsQuery = input.ownerExistsQuery;

  const readPolicyRevision = async (): Promise<PolicyRevision> => {
    const policyRows = await controlRepository.readAllPolicy();
    const ownerLifecycle = await controlRepository.getLifecycle("global");
    const consentRow = policyRows.find((row) => row.key === POLICY_KEY.consent);
    const rolloutRow = policyRows.find((row) => row.key === POLICY_KEY.rollout);
    const generation = ownerLifecycle?.generation ?? 0;
    return (
      `g${consentRow?.revision ?? 0}:` +
      `r${rolloutRow?.revision ?? 0}:` +
      `s0:c0:gen${generation}`
    );
  };

  return {
    async getCapabilityStatus(query: MemoryCapabilityQuery = {}): Promise<MemoryCapabilityStatus> {
      let owner = query.owner;
      let conversationExcluded: boolean | undefined;
      if (query.conversationId !== undefined) {
        const detail = await ownerExistsQuery.getConversationOwner(query.conversationId);
        if (detail === undefined || !detail.exists) {
          throw new MemoryError(
            "memory_owner_deleted",
            `Conversation ${query.conversationId} is unavailable for memory status.`,
          );
        }
        if (owner !== undefined && memoryOwnerKey(owner) !== memoryOwnerKey(detail.owner)) {
          throw new MemoryError(
            "memory_owner_deleted",
            `Conversation ${query.conversationId} does not belong to the requested memory owner.`,
          );
        }
        owner ??= detail.owner;
      }
      owner ??= { kind: "global" };
      const policyRows = await controlRepository.readAllPolicy();
      const ownerKey = memoryOwnerKey(owner);
      const ownerLifecycle = await controlRepository.getLifecycle(ownerKey);
      const conversationLifecycle = query.conversationId === undefined
        ? undefined
        : await controlRepository.getLifecycle(`conversation:${query.conversationId}`);
      const health = input.runtimeHealth === undefined ? "ready" : await input.runtimeHealth.read();
      // global scope：participation 行被忽略；具体 owner/conversation 查询则返回
      // 同一 policy snapshot 的 scoped participation，避免 UI 用 global consent 猜局部状态。
      const admission = resolveAdmissionFromPolicy({
        owner,
        conversationId: query.conversationId ?? "__capability_status__",
        turnOverrideOff: false,
        policyRows,
        ownerLifecycle,
        conversationLifecycle,
      });
      const participationRow = owner.kind === "global"
        ? undefined
        : policyRows.find((row) => row.key === participationKey(ownerKey));
      const requestedConversationId = query.conversationId;
      if (requestedConversationId !== undefined) {
        conversationExcluded = policyRows.find((row) => row.key === conversationExclusionKey(requestedConversationId))?.enabled ?? false;
      }
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
        ...(owner.kind === "global" ? {} : { scopeParticipation: participationRow?.enabled ?? false }),
        ...(conversationExcluded === undefined ? {} : { conversationExcluded }),
      };
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
        const existing = policyRows.find((row) => row.key === participationKey(ownerKey));
        await controlRepository.setPolicy({
          key: participationKey(ownerKey),
          kind: "scope_participation",
          scopeOwnerKey: ownerKey,
          enabled,
          ...(existing === undefined ? {} : { expectedRevision: existing.revision }),
        });
        return { policyRevision: await readPolicyRevision() };
      });
    },

    async setConversationParticipation({ conversationId, excluded }) {
      // Conversation participation（exclusion）必须先确认 conversation 仍存在
      // 且 owner 未删除；conversation-control-repo.get 返回 undefined 即拒。
      // 重读避免迟到的删除与 admission 之间的交错（手册 12.4）。
      const initialDetail = await ownerExistsQuery.getConversationOwner(conversationId);
      if (initialDetail === undefined || !initialDetail.exists) {
        throw new MemoryError(
          "memory_owner_deleted",
          `Conversation ${conversationId} is unavailable for participation.`,
        );
      }
      const ownerAdmission = initialDetail.owner.kind === "space"
        ? spaceAdmission
        : workspaceAdmission;
      return await ownerAdmission.admit(initialDetail.owner.id, async () => await conversationAdmission.admit(
        conversationId,
        async () => {
          const detail = await ownerExistsQuery.getConversationOwner(conversationId);
          if (detail === undefined || !detail.exists) {
            throw new MemoryError(
              "memory_owner_deleted",
              `Conversation ${conversationId} is unavailable for participation.`,
            );
          }
          await assertOwnerAvailable(ownerExistsQuery, detail.owner);
          const policyRows = await controlRepository.readAllPolicy();
          const existing = policyRows.find((row) => row.key === conversationExclusionKey(conversationId));
          await controlRepository.setPolicy({
            key: conversationExclusionKey(conversationId),
            kind: "conversation_exclusion",
            scopeOwnerKey: null,
            enabled: excluded,
            ...(existing === undefined ? {} : { expectedRevision: existing.revision }),
          });
          if (excluded) {
            // 排除从生效边界起立即撤销含该对话 provenance 的派生记录；保留游标，
            // 允许未来重新参与时只处理新的稳定轮次，不回填排除区间。
            await input.contentRepository.purgeConversation(conversationId, { preserveCursor: true });
          }
          return { policyRevision: await readPolicyRevision() };
        },
      ));
    },

    async clearImplicitMemory({ scope }): Promise<ClearImplicitMemoryResult> {
      // 清除是 Memory Feature 内部的 fence → purge → 可继续参与工作流：不改变
      // 用户 consent/participation，也不让清除前历史在重新开启后被回填。
      const clear = async (): Promise<ClearImplicitMemoryResult> => {
        await assertOwnerAvailable(ownerExistsQuery, scope);
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
        return await lifecycle.clearOwnerMemory(scope);
      };
      if (scope.kind === "space") return await spaceAdmission.admit(scope.id, clear);
      if (scope.kind === "workspace") return await workspaceAdmission.admit(scope.id, clear);
      return await clear();
    },
  };
}
