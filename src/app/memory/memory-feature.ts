/**
 * Memory Feature facade：跨子目录（admin / capture / recall / lifecycle /
 * store / policy）的统一公开面。本文件只承担"薄转发"，不引入新的不变量。
 *
 * 现有 surface：
 * - commands: setConsent / setSpaceParticipation /
 *   clearImplicitMemory → 直转 MemoryAdminApplication；
 * - queries: capability/diagnostics → 直转对应 Application/query port。
 *
 * captureRuntime / contextProvider / lifecycle 仍由 Composition Root 装配；本
 * facade 不把它们伪装成可由 Route 直接组合的 Repository。
 *
 * 不变量：
 * - facade 不缓存任何 policy 状态；每次调用都转交 admin 重算；
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
  MemoryDiagnosticQuery,
  MemoryDiagnosticSearchInput,
  HistorySearchResult,
  MemoryRolloutMode,
  PolicyRevision,
  WriteSpaceMemoryResult,
} from "./contracts.js";

export type MemoryFeatureCommands = {
  setRollout(input: { rollout: MemoryRolloutMode }): Promise<{ policyRevision: PolicyRevision }>;
  setConsent(input: { globalConsent: boolean }): Promise<{ policyRevision: PolicyRevision }>;
  setSpaceParticipation(input: { spaceId: string; enabled: boolean }): Promise<{ policyRevision: PolicyRevision }>;
  clearImplicitMemory(input: { scope: MemoryOwner }): Promise<ClearImplicitMemoryResult>;
  writeSpaceMemory(input: {
    readonly spaceId: string;
    readonly expectedRevisionId: string | null;
    readonly markdown: string;
    readonly requestId: string;
  }): Promise<WriteSpaceMemoryResult>;
};

export type MemoryFeatureQueries = {
  getCapabilityStatus(input?: MemoryCapabilityQuery): Promise<MemoryCapabilityStatus>;
  getDiagnosticSnapshot(input?: MemoryDiagnosticQuery): Promise<MemoryDiagnosticSnapshot>;
  searchDiagnosticHistory(input: MemoryDiagnosticSearchInput): Promise<HistorySearchResult>;
  getSpaceMemoryView(input: { readonly spaceId: string }): Promise<{
    readonly document: {
      readonly revisionId: string;
      readonly revision: number;
      readonly origin: "model" | "user_edit";
      readonly markdown: string;
      readonly generation: number;
      readonly updatedAt: number;
    } | undefined;
    readonly sources: readonly {
      readonly conversationId: string;
      readonly fromOrdinal: number;
      readonly toOrdinal: number;
      readonly title?: string;
      readonly sourceTime?: string;
    }[];
    readonly summaryCount: number;
    readonly lastMaintenanceAt: number | null;
  }>;
};

export type MemoryFeature = {
  readonly commands: MemoryFeatureCommands;
  readonly queries: MemoryFeatureQueries;
};

export function createMemoryFeature(input: {
  readonly adminApplication: MemoryAdminApplication;
  readonly diagnostics?: {
    readonly getSnapshot: (input?: MemoryDiagnosticQuery) => Promise<MemoryDiagnosticSnapshot>;
    readonly searchHistory: (input: MemoryDiagnosticSearchInput) => Promise<HistorySearchResult>;
  };
}): MemoryFeature {
  const admin = input.adminApplication;
  const diagnostics = input.diagnostics ?? {
    async getSnapshot(): Promise<MemoryDiagnosticSnapshot> {
      return { enabled: false, generatedAt: Date.now(), capability: null, jobs: { queued: 0, running: 0, done: 0, failed: 0 },
        recentOutcomes: [], jobRows: [], jobRowsTruncated: false, context: null, limits: null };
    },
    async searchHistory(): Promise<HistorySearchResult> {
      return { outcome: "degraded", coverage: { summary: "unavailable", transcript: "unavailable" }, items: [] };
    },
  };
  return {
    commands: {
      async setRollout(args) {
        return await admin.setRollout(args);
      },
      async setConsent(args) {
        return await admin.setConsent(args);
      },
      async setSpaceParticipation(args) {
        return await admin.setSpaceParticipation(args);
      },
      async clearImplicitMemory(args) {
        return await admin.clearImplicitMemory(args);
      },
      async writeSpaceMemory(args) {
        return await admin.writeSpaceMemory(args);
      },
    },
    queries: {
      async getCapabilityStatus(input) {
        return await admin.getCapabilityStatus(input);
      },
      async getDiagnosticSnapshot(args) {
        return await diagnostics.getSnapshot(args);
      },
      async searchDiagnosticHistory(args) {
        return await diagnostics.searchHistory(args);
      },
      async getSpaceMemoryView(args) {
        return await admin.getSpaceMemoryView(args);
      },
    },
  };
}
