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
 * - clearImplicitMemory 是单个 destructive 命令（不是 lifecycle prepare/finalize
 *   两阶段）：lifecycle.prepareOwnerRemoval 已把 owner 升 generation+1 并立
 *   fenced，本 Application 拿到 ticket 后自完成 fence=tombstone 并 retireActive
 *   （Phase 1 没有 records/source 表时 fence=tombstone 即物理清理）；不通过
 *   WorkbenchCoordination，只在 Memory Feature 内部完成 fence/purge；
 * - getCapabilityStatus 重算 effective admission（global scope）并报告当前
 *   rollout / health 派生事实，不缓存（手册 7.1）。
 *
 * Application 不 import panel-server / workspaces / personal-knowledge；owner
 * 存在性/admission 由 Composition Root 注入的 read-model/admission 端口承担，
 * Memory 内部再决定 policy 写路径。
 */

import { memoryOwnerKey, type MemoryOwner } from "../../../domain/memory/index.js";
import type { SpaceAdmission } from "../../ownership/admission.js";
import {
  MemoryError,
  type ClearImplicitMemoryResult,
  type MemoryAdminApplication,
  type MemoryCapabilityStatus,
  type MemoryRuntimeHealth,
  type PolicyRevision,
  type RemovalTicket,
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
    | ((conversationId: string) => Promise<{ readonly exists: boolean; readonly owner: MemoryOwner } | undefined>);
};

/** Runtime health 派生端口；Phase 1 固定为 ready/degraded（来自 controlRepository 状态）。 */
export type MemoryRuntimeHealthQuery = {
  readonly read: () => Promise<MemoryRuntimeHealth>;
};

export type CreateMemoryAdminApplicationInput = {
  readonly controlRepository: MemoryControlRepository;
  readonly lifecycle: MemoryLifecycle;
  /** 提供则在 clearImplicitMemory 同事务内 retire 所有 active records；缺省 Phase 1 行为仅 fence/purge。 */
  readonly contentRepository?: MemoryContentRepository;
  readonly spaceAdmission: SpaceAdmission;
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
    async getCapabilityStatus(): Promise<MemoryCapabilityStatus> {
      const policyRows = await controlRepository.readAllPolicy();
      const ownerLifecycle = await controlRepository.getLifecycle("global");
      const health = input.runtimeHealth === undefined ? "ready" : await input.runtimeHealth.read();
      // global scope：participation 行被忽略，但 generation/fence 与 globalConsent/rollout
      // 仍决定 effective；用于 UI 与 health 字段配套报告（手册 12.1）。
      const admission = resolveAdmissionFromPolicy({
        owner: { kind: "global" },
        conversationId: "__capability_status__",
        turnOverrideOff: false,
        policyRows,
        ownerLifecycle,
        conversationLifecycle: undefined,
      });
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
      return { policyRevision: await readPolicyRevision() };
    },

    async clearImplicitMemory({ scope }): Promise<ClearImplicitMemoryResult> {
      // Phase 1 fence=单事务完成：prepare 立 durable fence（generation+1 + fenced）；
      // 然后自完成 fence=tombstone。后续 recall 会因 generation 不匹配自动过滤掉旧
      // records（《手册》7.1 / 12.4），不依赖 WorkbenchCoordination 的两阶段（用户
      // 清除只破坏 MemoryFeature 内部状态，不触发 owner/conversation 本体删除）。
      const ticket: RemovalTicket = await lifecycle.prepareOwnerRemoval(scope);
      const ownerKey = memoryOwnerKey(scope);
      // fence=tombstone：把 lifecycle 翻到终态；后续任何 owner/conversation
      // admission 重读都会看到 generation 已经 bump（不与删除工作流冲突）。
      await controlRepository.setLifecycleFence(ownerKey, "tombstone");
      const finalLifecycle = await controlRepository.getLifecycle(ownerKey);
      return { generation: finalLifecycle?.generation ?? ticket.fencedGeneration };
    },
  };
}