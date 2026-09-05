import { memoryOwnerKey, type MemoryOwner } from "../../../domain/memory/index.js";
import type {
  MemoryBackgroundPort,
  SpaceMemoryBackground,
} from "../contracts.js";
import { resolveAdmissionFromPolicy } from "../policy/policy-snapshot.js";
import type { MemoryDocumentRepository } from "../store/content-repository.js";
import type { MemoryControlRepository } from "../store/control-repository.js";

/**
 * 背景供给端口实现（正式设计 §9）：
 * - getActiveSpaceMemoryHead：新会话绑定时读取当前 head（只读引用，不复制正文所有权）；
 * - resolveSupplyableBackground：每次 provider 请求冻结前复核 effective=active、
 *   generation 与绑定 revision 的 validity；任一不满足返回 undefined（无贡献），
 *   绝不自动换绑到新版本。
 */
export function createMemoryBackgroundPort(deps: {
  readonly controlRepository: MemoryControlRepository;
  readonly documentRepository: MemoryDocumentRepository;
}): MemoryBackgroundPort {
  return {
    async getActiveSpaceMemoryHead(owner: MemoryOwner): Promise<SpaceMemoryBackground | undefined> {
      const head = await deps.documentRepository.getActiveSpaceMemoryHead(memoryOwnerKey(owner));
      return head === undefined ? undefined : {
        revisionId: head.revisionId,
        revision: head.revision,
        origin: head.origin,
        markdown: head.markdown,
        generation: head.generation,
        updatedAt: head.updatedAt,
      };
    },

    async resolveSupplyableBackground(input: {
      readonly owner: MemoryOwner;
      readonly revisionId: string;
      readonly generation: number;
    }): Promise<SpaceMemoryBackground | undefined> {
      const ownerKey = memoryOwnerKey(input.owner);
      const [policyRows, ownerLifecycle, row] = await Promise.all([
        deps.controlRepository.readAllPolicy(),
        deps.controlRepository.getLifecycle(ownerKey),
        deps.documentRepository.getSpaceMemoryRevision(input.revisionId),
      ]);
      if (row === undefined || row.validity !== "valid") return undefined;
      // 绑定携带的 generation 与当前 owner generation 不一致（clear/删除）→ 停止供给。
      if (row.generation !== input.generation) return undefined;
      const admission = resolveAdmissionFromPolicy({
        owner: input.owner,
        conversationId: "__memory_background__",
        policyRows,
        ownerLifecycle,
        conversationLifecycle: undefined,
      });
      // shadow 只整理不注入；供给要求 active。
      if (admission.effective !== "active") return undefined;
      return {
        revisionId: row.revisionId,
        revision: row.revision,
        origin: row.origin,
        markdown: row.markdown,
        generation: row.generation,
        updatedAt: row.updatedAt,
      };
    },
  };
}
