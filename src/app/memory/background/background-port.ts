import { memoryOwnerKey } from "../../../domain/memory/index.js";
import type { ConversationOwner } from "../../../domain/execution-scope/contracts.js";
import type {
  MemoryBackgroundPort,
  OwnerMemoryBackground,
} from "../contracts.js";
import type { MemoryDocumentRepository } from "../store/content-repository.js";

/**
 * 背景供给端口实现（正式设计 §9）：
 * - getActiveOwnerMemoryHead：新会话绑定时读取当前 head（只读引用，不复制正文所有权）；
 * - resolveSupplyableBackground：事务仓储是政策、结构身份、generation、revision
 *   validity、精确依赖撤销及分支支持的唯一权威供给口；来源删除仅动态报告 readback；此处只映射模型 DTO，
 *   不满足时返回 undefined（无贡献），绝不自动换绑到新版本。
 */
function projectBackground(current: NonNullable<Awaited<ReturnType<MemoryDocumentRepository["getSupplyableMemoryRevision"]>>>): OwnerMemoryBackground {
  return { revisionId: current.revisionId, revision: current.revision, origin: current.origin,
    markdown: current.markdown, generation: current.generation, updatedAt: current.updatedAt, sourceStates: current.sourceStates };
}

export function createMemoryBackgroundPort(deps: {
  readonly documentRepository: Pick<
    MemoryDocumentRepository,
    "getActiveOwnerMemoryHead" | "getSupplyableMemoryRevision"
  >;
}): MemoryBackgroundPort {
  return {
    async getActiveOwnerMemoryHead(owner: ConversationOwner): Promise<OwnerMemoryBackground | undefined> {
      const head = await deps.documentRepository.getActiveOwnerMemoryHead(memoryOwnerKey(owner));
      if (head === undefined) return undefined;
      const current = await deps.documentRepository.getSupplyableMemoryRevision({ ownerKey: memoryOwnerKey(owner), revisionId: head.revisionId, generation: head.generation });
      return current === undefined ? undefined : projectBackground(current);
    },

    async resolveSupplyableBackground(input: {
      readonly owner: ConversationOwner;
      readonly revisionId: string;
      readonly generation: number;
    }): Promise<OwnerMemoryBackground | undefined> {
      const current = await deps.documentRepository.getSupplyableMemoryRevision({
        ownerKey: memoryOwnerKey(input.owner),
        revisionId: input.revisionId,
        generation: input.generation,
      });
      if (current === undefined) return undefined;
      return projectBackground(current);
    },
  };
}
