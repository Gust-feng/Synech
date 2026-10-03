import { createId, nowIso, type IdFactory } from "../../../kernel/id.js";
import { memoryOwnerKey, type MemoryOwner } from "../../../domain/memory/index.js";
import type { MemoryControlRepository } from "../store/control-repository.js";
import type { MemoryDocumentRepository } from "../store/content-repository.js";
import { MemoryError, type MemoryLifecycle, type RemovalTicket } from "../contracts.js";

/** Durable fences precede cleanup. Conversation deletion retains published recognitions. */
export function createControlMemoryLifecycle(
  repository: MemoryControlRepository,
  options: {
    readonly idFactory?: IdFactory;
    readonly documentRepository?: Pick<MemoryDocumentRepository,
      "markConversationSourcesDeleted" | "purgeConversationAuxiliaries" | "supersedeConversationSources" |
      "purgeOwner" | "purgeAll" | "setExcludedThrough" | "getProgress"
    >;
  } = {},
): MemoryLifecycle {
  const idFactory = options.idFactory ?? createId;
  const conversationKey = (id: string) => `conversation:${id}`;
  const prepare = async (scope: RemovalTicket["scope"]): Promise<RemovalTicket> => {
    const key = scope.kind === "owner" ? memoryOwnerKey(scope.owner) : conversationKey(scope.conversationId);
    const fenced = await repository.fenceForRemoval(key);
    return { ticketId: idFactory("memrm"), scope, fencedGeneration: fenced.generation, preparedAt: nowIso() };
  };
  const finalize = async (ticket: RemovalTicket, key: string) => {
    const current = await repository.getLifecycle(key);
    if (current === undefined || current.generation !== ticket.fencedGeneration ||
        (current.fenceState !== "fenced" && current.fenceState !== "tombstone")) {
      throw new MemoryError("memory_generation_fenced", "Removal ticket is stale.");
    }
    if (current.fenceState === "fenced") await repository.setLifecycleFence(key, "tombstone", null, ticket.fencedGeneration);
    if (ticket.scope.kind === "owner") {
      await options.documentRepository?.purgeOwner(key, { preserveExclusions: true });
    } else {
      await options.documentRepository?.markConversationSourcesDeleted(ticket.scope.conversationId);
      await options.documentRepository?.purgeConversationAuxiliaries(ticket.scope.conversationId);
    }
  };
  return {
    async prepareOwnerRemoval(owner: MemoryOwner) { return prepare({ kind: "owner", owner }); },
    async finalizeOwnerRemoval(ticket) {
      if (ticket.scope.kind !== "owner") throw new MemoryError("memory_invalid_owner", "Owner ticket required.");
      await finalize(ticket, memoryOwnerKey(ticket.scope.owner));
    },
    async clearOwnerMemory(owner) {
      const ticket = await prepare({ kind: "owner", owner });
      const key = memoryOwnerKey(owner);
      if (owner.kind === "global") await options.documentRepository?.purgeAll({ preserveExclusions: true });
      else await options.documentRepository?.purgeOwner(key, { preserveExclusions: true });
      const reset = await repository.setLifecycleFence(key, "none", null, ticket.fencedGeneration);
      return { generation: reset.generation };
    },
    async supersedeConversationSources(input) {
      const ticket = await prepare({ kind: "conversation", conversationId: input.conversationId });
      const progress = await options.documentRepository?.getProgress(input.conversationId);
      await options.documentRepository?.supersedeConversationSources(input);
      await options.documentRepository?.purgeConversationAuxiliaries(input.conversationId, { preserveExclusions: true });
      await options.documentRepository?.setExcludedThrough({ conversationId: input.conversationId,
        ownerKey: memoryOwnerKey(input.owner), excludedThroughOrdinal: Math.max(progress?.excludedThroughOrdinal ?? 0, input.retainedThroughOrdinal ?? 0), now: Date.now() });
      await repository.setLifecycleFence(conversationKey(input.conversationId), "none", null, ticket.fencedGeneration);
    },
    async prepareConversationRemoval(id) { return prepare({ kind: "conversation", conversationId: id }); },
    async finalizeConversationRemoval(ticket) {
      if (ticket.scope.kind !== "conversation") throw new MemoryError("memory_invalid_owner", "Conversation ticket required.");
      await finalize(ticket, conversationKey(ticket.scope.conversationId));
    },
  };
}
