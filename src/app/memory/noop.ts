import { type MemoryOwner } from "../../domain/memory/index.js";
import type {
  HistoryQueryPort,
  HistoryReadInput,
  HistoryReadResult,
  HistorySearchInput,
  HistorySearchResult,
  MemoryBackgroundPort,
  MemoryCaptureAcceptance,
  MemoryCaptureRuntime,
  MemoryCaptureSignal,
  MemoryLifecycle,
  SpaceMemoryBackground,
} from "./contracts.js";

/**
 * 可缺席组合的 No-op 实现（ADR：Memory 是可选背景供给方，不是 Core 前提）。
 *
 * - NoopMemoryCaptureRuntime：稳定信号一律 skipped，不调度整理、不写数据。
 * - NoopMemoryBackgroundPort：背景供给恒为 absent，不产生任何模型可见文本。
 * - NoopMemoryHistoryQueryPort：查询如实报告 unavailable，不伪装 no-hit。
 * - ProvenAbsentMemoryLifecycle：仅当能证明从未创建 Memory schema/data 时才允许装配；
 *   此时"删除/清除"本就无对象。
 *
 * 反例边界：关闭功能、查询失败、索引损坏都不是"数据不存在"，那些场景必须装配
 * Durable lifecycle 真实执行 fence/清理或明确失败，绝不能用 ProvenAbsent 假装成功。
 */

export function createNoopMemoryCaptureRuntime(): MemoryCaptureRuntime {
  return {
    async acceptStableSignal(_signal: MemoryCaptureSignal): Promise<MemoryCaptureAcceptance> {
      return { status: "skipped", reason: "memory_unavailable" };
    },
    async release(): Promise<void> {},
  };
}

export function createNoopMemoryBackgroundPort(): MemoryBackgroundPort {
  return {
    async getActiveSpaceMemoryHead(_owner: MemoryOwner): Promise<SpaceMemoryBackground | undefined> {
      return undefined;
    },
    async resolveSupplyableBackground(_input: {
      readonly owner: MemoryOwner;
      readonly revisionId: string;
      readonly generation: number;
    }): Promise<SpaceMemoryBackground | undefined> {
      return undefined;
    },
  };
}

export function createNoopMemoryHistoryQueryPort(): HistoryQueryPort {
  return {
    async search(_input: HistorySearchInput): Promise<HistorySearchResult> {
      return {
        outcome: "degraded",
        coverage: { summary: "unavailable", transcript: "unavailable" },
        items: [],
      };
    },
    async read(_input: HistoryReadInput): Promise<HistoryReadResult> {
      return { outcome: "unavailable", reason: "memory_unavailable" };
    },
  };
}

export function createUnavailableMemoryLifecycle(): MemoryLifecycle {
  const unavailable = (): never => {
    throw new Error("Memory lifecycle is unavailable because the memory store is not configured.");
  };
  return {
    async prepareOwnerRemoval() {
      return unavailable();
    },
    async finalizeOwnerRemoval() {
      return unavailable();
    },
    async clearOwnerMemory() {
      return unavailable();
    },
    async prepareConversationRemoval() {
      return unavailable();
    },
    async finalizeConversationRemoval() {
      return unavailable();
    },
  };
}

/**
 * ProvenAbsent：只有组合根能证明全新安装（从未创建 Memory schema/data）时装配。
 * 删除协调调用本实现表示"确认无数据可清理"，不是把失败伪装成成功。
 */
export function createProvenAbsentMemoryLifecycle(): MemoryLifecycle {
  const provenAbsent = (): never => {
    throw new Error(
      "Memory lifecycle is proven absent: this product home never created memory data.",
    );
  };
  return {
    async prepareOwnerRemoval() {
      return provenAbsent();
    },
    async finalizeOwnerRemoval() {
      return provenAbsent();
    },
    async clearOwnerMemory() {
      return provenAbsent();
    },
    async prepareConversationRemoval() {
      return provenAbsent();
    },
    async finalizeConversationRemoval() {
      return provenAbsent();
    },
  };
}
