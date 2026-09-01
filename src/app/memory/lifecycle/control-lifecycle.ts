import { createId, nowIso, type IdFactory } from "../../../kernel/id.js";
import { memoryOwnerKey, type MemoryOwner } from "../../../domain/memory/index.js";
import type { MemoryControlRepository } from "../store/control-repository.js";
import { MemoryError, type MemoryLifecycle, type RemovalTicket } from "../contracts.js";

/**
 * Durable 删除生命周期（ADR 12.5/12.6 两阶段），基于 memory_lifecycle 控制表。
 *
 * prepare：bump generation 立 durable fence（所有旧请求携带的 generation 即刻失效，
 * fence 之后迟到的 capture/recall 必须被 Policy Gate 拒绝），返回带 fencedGeneration
 * 的 ticket；协调方在 owner/conversation 本体删除后调用 finalize 落 tombstone。
 *
 * Phase 1 没有 records/sources 表，finalize 只翻 fence 状态；Phase 3 起在同一
 * finalize 事务内清理派生记录与 job，删除语义不变。
 */
export function createControlMemoryLifecycle(
  repository: MemoryControlRepository,
  options: { readonly idFactory?: IdFactory } = {},
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
    if (current.generation !== ticket.fencedGeneration || current.fenceState !== "fenced") {
      throw new MemoryError(
        "memory_generation_fenced",
        `Removal ticket ${ticket.ticketId} is stale for ${ownerKey} (generation ${current.generation}, fence ${current.fenceState}).`,
      );
    }
    await repository.setLifecycleFence(ownerKey, "tombstone");
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
