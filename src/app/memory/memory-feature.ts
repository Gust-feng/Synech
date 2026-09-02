/**
 * Memory Feature facade：跨子目录（admin / capture / recall / lifecycle /
 * store / policy）的统一公开面。本文件只承担"薄转发"，不引入新的不变量。
 *
 * 现有 surface：
 * - commands: setConsent / setSpaceParticipation / setConversationParticipation /
 *   clearImplicitMemory → 直转 MemoryAdminApplication；
 * - queries: capability/diagnostics → 直转对应 Application/query port。
 *
 * captureRuntime / contextProvider / lifecycle 仍由 Composition Root 装配；本
 * facade 不把它们伪装成可由 Route 直接组合的 Repository。
 *
 * 不变量：
 * - facade 不缓存任何 policy 状态；每次调用都转交 admin 重算（手册 7.1）；
 * - facade 不引入 owner admission：admission 与 owner 存在性已经在 admin 层
 *   完成，facade 不再"包一层 serialize"。
 */

import type { MemoryOwner } from "../../domain/memory/index.js";
import type {
  ClearImplicitMemoryResult,
  MemoryCapabilityQuery,
  MemoryAdminApplication,
  MemoryCapabilityStatus,
  MemoryDiagnosticSnapshot,
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
  getCapabilityStatus(input?: MemoryCapabilityQuery): Promise<MemoryCapabilityStatus>;
  getDiagnosticSnapshot(): Promise<MemoryDiagnosticSnapshot>;
};

export type MemoryFeature = {
  readonly commands: MemoryFeatureCommands;
  readonly queries: MemoryFeatureQueries;
};

export function createMemoryFeature(input: {
  readonly adminApplication: MemoryAdminApplication;
  readonly diagnostics?: { readonly getSnapshot: () => Promise<MemoryDiagnosticSnapshot> };
}): MemoryFeature {
  const admin = input.adminApplication;
  const diagnostics = input.diagnostics ?? {
    async getSnapshot(): Promise<MemoryDiagnosticSnapshot> {
      return {
        enabled: false,
        traces: [],
        shadowWouldInject: [],
        jobs: { queued: 0, running: 0, done: 0, failed: 0 },
      };
    },
  };
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
      async getCapabilityStatus(input) {
        return await admin.getCapabilityStatus(input);
      },
      async getDiagnosticSnapshot() {
        return await diagnostics.getSnapshot();
      },
    },
  };
}
