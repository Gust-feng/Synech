/**
 * Memory Feature facade（T23）：跨子目录（admin / capture / recall / lifecycle /
 * store / policy）的统一公开面。本文件只承担"薄转发"，不引入新的不变量。
 *
 * 现有 surface（本卡 T23 范围）：
 * - commands: setConsent / setSpaceParticipation / setConversationParticipation /
 *   clearImplicitMemory → 直转 MemoryAdminApplication；
 * - queries: getCapabilityStatus → 直转 MemoryAdminApplication。
 *
 * 不在本卡：captureRuntime / contextProvider / lifecycle（已分别挂在
 * createMemoryRuntime / createControlMemoryLifecycle 上，由 Composition Root
 * 装配），后续 T24+ 才会把 queries.getAdmissionFor / getDiagnosticSnapshot 接入。
 *
 * 不变量：
 * - facade 不缓存任何 policy 状态；每次调用都转交 admin 重算（手册 7.1）；
 * - facade 不引入 owner admission：admission 与 owner 存在性已经在 admin 层
 *   完成，facade 不再"包一层 serialize"。
 */

import type { MemoryOwner } from "../../domain/memory/index.js";
import type {
  ClearImplicitMemoryResult,
  MemoryAdminApplication,
  MemoryCapabilityStatus,
  PolicyRevision,
} from "./contracts.js";

export type MemoryFeatureCommands = {
  setConsent(input: { globalConsent: boolean }): Promise<{ policyRevision: PolicyRevision }>;
  setSpaceParticipation(input: { spaceId: string; enabled: boolean }): Promise<{ policyRevision: PolicyRevision }>;
  setConversationParticipation(
    input: { conversationId: string; excluded: boolean },
  ): Promise<{ policyRevision: PolicyRevision }>;
  clearImplicitMemory(input: { scope: MemoryOwner }): Promise<ClearImplicitMemoryResult>;
};

export type MemoryFeatureQueries = {
  getCapabilityStatus(): Promise<MemoryCapabilityStatus>;
  // 占位：T24+ 再挂 getAdmissionFor / getDiagnosticSnapshot，本卡不实现，避免
  // 现在引出第二条事实源/重复实现（手册 23"尚未冻结"）。
};

export type MemoryFeature = {
  readonly commands: MemoryFeatureCommands;
  readonly queries: MemoryFeatureQueries;
};

export function createMemoryFeature(input: {
  readonly adminApplication: MemoryAdminApplication;
}): MemoryFeature {
  const admin = input.adminApplication;
  return {
    commands: {
      async setConsent(args) {
        return await admin.setConsent(args);
      },
      async setSpaceParticipation(args) {
        return await admin.setSpaceParticipation(args);
      },
      async setConversationParticipation(args) {
        return await admin.setConversationParticipation(args);
      },
      async clearImplicitMemory(args) {
        return await admin.clearImplicitMemory(args);
      },
    },
    queries: {
      async getCapabilityStatus() {
        return await admin.getCapabilityStatus();
      },
    },
  };
}