/**
 * 可缺席组合的 No-op 实现（ADR：Memory 是可选 Context Provider，不是 Core 前提）。
 *
 * 三对装配中的缺席侧：
 * - NoopMemoryContextProvider：Recall 恒为空贡献，不产生任何模型可见文本。
 * - NoopMemoryCaptureRuntime：稳定信号一律 skipped，不调度提炼、不写数据。
 * - ProvenAbsentMemoryLifecycle：仅当能证明从未创建 Memory schema/data 时才允许装配；
 *   此时"删除/清除"本就无对象，prepare/finalize 是幂等空操作。
 *
 * 反例边界：关闭功能、Recall 失败、索引损坏都不是"数据不存在"，那些场景必须装配
 * Durable lifecycle 真实执行 fence/清理或明确失败，绝不能用本文件的 ProvenAbsent
 * 假装成功（ADR 可缺席组合段、《手册》5.2）。
 */

import { nowIso } from "../../kernel/id.js";
import { memoryOwnerKey, type MemoryOwner } from "../../domain/memory/index.js";
import {
  MemoryError,
  type MemoryCaptureAcceptance,
  type MemoryCaptureRuntime,
  type MemoryCaptureSignal,
  type MemoryContextContribution,
  type MemoryContextProvider,
  type MemoryContributeInput,
  type MemoryLifecycle,
  type RemovalTicket,
} from "./contracts.js";
const NOOP_POLICY_REVISION = "noop:0" as const;

function emptyContribution(owner: MemoryOwner): MemoryContextContribution {
  return {
    source: "implicit_memory",
    snapshot: {
      recallId: "noop",
      storeRevision: "0",
      policyRevision: NOOP_POLICY_REVISION,
      generation: 0,
      ownerKey: memoryOwnerKey(owner),
    },
    entries: [],
  };
}

export function createNoopMemoryContextProvider(): MemoryContextProvider {
  return {
    async contribute(input: MemoryContributeInput): Promise<MemoryContextContribution> {
      return emptyContribution(input.owner);
    },
  };
}

export function createNoopMemoryCaptureRuntime(): MemoryCaptureRuntime {
  return {
    async acceptStableSignal(_signal: MemoryCaptureSignal): Promise<MemoryCaptureAcceptance> {
      return { status: "skipped", reason: "memory_capture_disabled" };
    },
    async noteActivity(): Promise<void> {
      // No-op：缺席装配下没有积压缺口需要补扫，且永不向主链路抛出。
    },
    async release(): Promise<void> {
      // No-op：没有后台资源。
    },
  };
}

/**
 * 仅用于"从未存在 Memory 数据"的新安装。装配方必须先独立证明该前提；
 * 本实现不自行检查数据库（它不持有任何连接）。
 */
export function createProvenAbsentMemoryLifecycle(): MemoryLifecycle {
  const absentTicket = (scope: RemovalTicket["scope"]): RemovalTicket => ({
    ticketId: `absent:${scope.kind}:${nowIso()}`,
    scope,
    fencedGeneration: 0,
    preparedAt: nowIso(),
  });
  return {
    async prepareOwnerRemoval(owner: MemoryOwner): Promise<RemovalTicket> {
      return absentTicket({ kind: "owner", owner });
    },
    async finalizeOwnerRemoval(_ticket: RemovalTicket): Promise<void> {
      // 从未有数据：无对象可清理。
    },
    async clearOwnerMemory(_owner: MemoryOwner): Promise<{ readonly generation: number }> {
      // 从未有数据：清除是幂等空操作。
      return { generation: 0 };
    },
    async prepareConversationRemoval(conversationId: string): Promise<RemovalTicket> {
      return absentTicket({ kind: "conversation", conversationId });
    },
    async finalizeConversationRemoval(_ticket: RemovalTicket): Promise<void> {
      // 从未有数据：无对象可清理。
    },
  };
}

/** Control-only composition keeps Core alive but cannot claim a data purge. */
export function createUnavailableMemoryLifecycle(): MemoryLifecycle {
  const unavailable = async (): Promise<never> => {
    throw new MemoryError(
      "memory_store_failure",
      "Memory content storage is unavailable; lifecycle operation was not applied.",
    );
  };
  return {
    prepareOwnerRemoval: unavailable,
    finalizeOwnerRemoval: unavailable,
    clearOwnerMemory: unavailable,
    prepareConversationRemoval: unavailable,
    finalizeConversationRemoval: unavailable,
  };
}
