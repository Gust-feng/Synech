import { createId, nowIso, type IdFactory } from "../../../kernel/id.js";
import { memoryOwnerKey, type MemoryOwner } from "../../../domain/memory/index.js";
import type { MemoryControlRepository } from "../store/control-repository.js";
import type { MemoryContentRepository } from "../store/content-repository.js";
import { MemoryError, type MemoryLifecycle, type RemovalTicket } from "../contracts.js";

/**
 * Durable 删除生命周期（ADR 12.5/12.6 两阶段），基于 memory_lifecycle 控制表。
 *
 * prepare：bump generation 立 durable fence（所有旧请求携带的 generation 即刻失效，
 * fence 之后迟到的 capture/recall 必须被 Policy Gate 拒绝），返回带 fencedGeneration
 * 的 ticket；协调方在 owner/conversation 本体删除后调用 finalize 落 tombstone。
 *
 * finalize 先把 fence 收敛到 tombstone，再通过注入的内容仓储清理 Record、Source、
 * Cursor、Job、Outbox 与索引投影；物理清理失败时 fence 保持有效，重试仍可收敛。
 */
export function createControlMemoryLifecycle(
  repository: MemoryControlRepository,
  options: {
    readonly idFactory?: IdFactory;
    readonly contentRepository?: Pick<MemoryContentRepository, "purgeOwner" | "purgeAll" | "purgeConversation">;
  } = {},
): MemoryLifecycle {
  const idFactory = options.idFactory ?? createId;
  const conversationKey = (conversationId: string) => `conversation:${conversationId}`;

  const prepare = async (scope: RemovalTicket["scope"]): Promise<RemovalTicket> => {
    const ownerKey = scope.kind === "owner" ? memoryOwnerKey(scope.owner) : conversationKey(scope.conversationId);
    // 单事务原子地 bump generation + 立 fenced，避免两步之间被并发 prepare/写入交错。
    const fenced = await repository.fenceForRemoval(ownerKey);
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
    if (options.contentRepository !== undefined) {
      if (ticket.scope.kind === "owner") {
        await options.contentRepository.purgeOwner(ownerKey);
      } else {
        await options.contentRepository.purgeConversation(ticket.scope.conversationId);
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
      const ticket = await prepare({ kind: "owner", owner });
      const ownerKey = memoryOwnerKey(owner);
      if (options.contentRepository !== undefined) {
        if (owner.kind === "global") {
          await options.contentRepository.purgeAll({ preserveCursors: true });
        } else {
          await options.contentRepository.purgeOwner(ownerKey, { preserveCursors: true });
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
