import { createId, nowIso, type IdFactory } from "../../../kernel/id.js";
import { memoryOwnerKey, type MemoryOwner } from "../../../domain/memory/index.js";
import type { MemoryControlRepository } from "../store/control-repository.js";
import type { MemoryDocumentRepository } from "../store/content-repository.js";
import { MemoryError, type MemoryLifecycle, type RemovalTicket } from "../contracts.js";

/**
 * Durable 删除生命周期（两阶段），基于 memory_lifecycle 控制表。
 *
 * prepare：bump generation 立 durable fence（所有旧请求携带的 generation 即刻失效，
 * fence 之后迟到的接单/整理/背景供给必须被 Policy Gate 拒绝），返回带 fencedGeneration
 * 的 ticket；来源删除的依赖失效也发生在 prepare：引用该会话来源的全部文档/总结
 * revision（含已被会话绑定的版本）立即失效并退出摘要投影（正式设计 §11.4"先失效"）。
 *
 * finalize 先把 fence 收敛到 tombstone，再通过注入的文档仓储物理清理总结、依赖
 * 文档 revision、来源、进度、transcript/摘要投影与任务；物理清理失败时 fence 保持
 * 有效，重试仍可收敛。
 */
export function createControlMemoryLifecycle(
  repository: MemoryControlRepository,
  options: {
    readonly idFactory?: IdFactory;
    readonly documentRepository?: Pick<
      MemoryDocumentRepository,
      "invalidateDependentRevisions" | "purgeOwner" | "purgeAll" | "purgeConversation"
    >;
  } = {},
): MemoryLifecycle {
  const idFactory = options.idFactory ?? createId;
  const conversationKey = (conversationId: string) => `conversation:${conversationId}`;

  const prepare = async (scope: RemovalTicket["scope"]): Promise<RemovalTicket> => {
    const ownerKey = scope.kind === "owner" ? memoryOwnerKey(scope.owner) : conversationKey(scope.conversationId);
    // 单事务原子地 bump generation + 立 fenced，避免两步之间被并发 prepare/写入交错。
    const fenced = await repository.fenceForRemoval(ownerKey);
    if (scope.kind === "conversation" && options.documentRepository !== undefined) {
      // 依赖该会话来源的派生版本必须先失效（R05）：失效写入失败时 prepare 必须
      // 上抛——生命周期保持「fence 已立、供给未断」的可重试拒绝状态，由删除
      // journal 重试恢复；吞掉异常会让依赖文档在清理停滞期间继续注入。
      await options.documentRepository.invalidateDependentRevisions(scope.conversationId);
    }
    return {
      ticketId: idFactory("memrm"),
      scope,
      fencedGeneration: fenced.generation,
      preparedAt: nowIso(),
    };
  };

  const finalize = async (ticket: RemovalTicket, ownerKey: string): Promise<void> => {
    const current = await repository.getLifecycle(ownerKey);
    if (current === undefined) {
      throw new MemoryError(
        "memory_generation_fenced",
        `Cannot finalize removal ${ticket.ticketId}: lifecycle row for ${ownerKey} is absent.`,
      );
    }
    if (current.generation !== ticket.fencedGeneration ||
      (current.fenceState !== "fenced" && current.fenceState !== "tombstone")) {
      throw new MemoryError(
        "memory_generation_fenced",
        `Removal ticket ${ticket.ticketId} is stale for ${ownerKey} (generation ${current.generation}, fence ${current.fenceState}).`,
      );
    }
    if (current.fenceState === "fenced") {
      await repository.setLifecycleFence(ownerKey, "tombstone", null, ticket.fencedGeneration);
    }
    if (options.documentRepository !== undefined) {
      if (ticket.scope.kind === "owner") {
        await options.documentRepository.purgeOwner(ownerKey);
      } else {
        await options.documentRepository.purgeConversation(ticket.scope.conversationId);
      }
    }
  };

  return {
    async prepareOwnerRemoval(owner: MemoryOwner) {
      return prepare({ kind: "owner", owner });
    },
    async finalizeOwnerRemoval(ticket: RemovalTicket) {
      if (ticket.scope.kind !== "owner") {
        throw new MemoryError("memory_invalid_owner", `Owner removal ticket ${ticket.ticketId} has wrong scope.`);
      }
      await finalize(ticket, memoryOwnerKey(ticket.scope.owner));
    },
    async clearOwnerMemory(owner: MemoryOwner) {
      // 清除工作流（Admin 已在 admission 边界写入排除高水位）：
      // fence → 派生内容 purge（保留进度行中的排除边界）→ 恢复为可继续参与状态。
      const ticket = await prepare({ kind: "owner", owner });
      const ownerKey = memoryOwnerKey(owner);
      if (options.documentRepository !== undefined) {
        if (owner.kind === "global") {
          await options.documentRepository.purgeAll({ preserveExclusions: true });
        } else {
          await options.documentRepository.purgeOwner(ownerKey, { preserveExclusions: true });
        }
      }
      const reset = await repository.setLifecycleFence(
        ownerKey,
        "none",
        null,
        ticket.fencedGeneration,
      );
      return { generation: reset.generation };
    },
    async prepareConversationRemoval(conversationId: string) {
      return prepare({ kind: "conversation", conversationId });
    },
    async finalizeConversationRemoval(ticket: RemovalTicket) {
      if (ticket.scope.kind !== "conversation") {
        throw new MemoryError("memory_invalid_owner", `Conversation removal ticket ${ticket.ticketId} has wrong scope.`);
      }
      await finalize(ticket, conversationKey(ticket.scope.conversationId));
    },
  };
}
