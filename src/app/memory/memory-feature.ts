/**
 * Memory Feature facade：Memory 命令与查询的唯一稳定入口。
 *
 * Route 只解析输入并调用一个 facade 方法；跨 Feature 的 owner 存在性、会话高水位
 * 和 owner admission 通过 Composition Root 注入窄查询/控制口，不由 Route 编排。
 */

import type { MemoryOwner } from "../../domain/memory/index.js";
import type { ConversationOwner } from "../../domain/execution-scope/contracts.js";
import type {
  ClearMemoryResult,
  HistorySearchResult,
  MemoryAdminApplication,
  MemoryCapabilityStatus,
  MemoryDiagnosticQuery,
  MemoryDiagnosticSearchInput,
  MemoryDiagnosticSnapshot,
  MemoryRolloutMode,
  PolicyRevision,
} from "./contracts.js";

import type { MemoryEntryAdminPort } from "./entry-contracts.js";

export type MemoryFeatureCommands = {
  setEnabled(input: { readonly enabled: boolean }): Promise<{ readonly policyRevision: PolicyRevision }>;
  setRollout(input: { readonly rollout: MemoryRolloutMode }): Promise<{ readonly policyRevision: PolicyRevision }>;
  clearMemory(input: { readonly scope: MemoryOwner }): Promise<ClearMemoryResult>;
  updateMemory: MemoryEntryAdminPort["updateMemory"];
};

export type MemoryFeatureQueries = {
  getStatus(input?: { readonly owner?: ConversationOwner }): Promise<MemoryCapabilityStatus>;
  getMemoryView: MemoryEntryAdminPort["getMemoryView"];
  getDiagnosticSnapshot(input?: MemoryDiagnosticQuery): Promise<MemoryDiagnosticSnapshot>;
  searchDiagnosticHistory(input: MemoryDiagnosticSearchInput): Promise<HistorySearchResult>;
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
      return {
        enabled: false,
        generatedAt: Date.now(),
        capability: null,
        jobs: { queued: 0, running: 0, done: 0, failed: 0 },
        recentOutcomes: [],
        jobRows: [],
        jobRowsTruncated: false,
        context: null,
        limits: null,
      };
    },
    async searchHistory(): Promise<HistorySearchResult> {
      return { outcome: "degraded", coverage: { summary: "unavailable", transcript: "unavailable" }, items: [] };
    },
  };

  return {
    commands: {
      async setEnabled(args) {
        return await admin.setEnabled(args);
      },
      async setRollout(args) {
        return await admin.setRollout(args);
      },
      async clearMemory(args) {
        return await admin.clearMemory(args);
      },
      async updateMemory(args) {
        return await admin.updateMemory(args);
      },
    },
    queries: {
      async getStatus(args) {
        return await admin.getStatus(args);
      },
      async getMemoryView(args) {
        return await admin.getMemoryView(args);
      },
      async getDiagnosticSnapshot(args) {
        return await diagnostics.getSnapshot(args);
      },
      async searchDiagnosticHistory(args) {
        return await diagnostics.searchHistory(args);
      },
    },
  };
}
