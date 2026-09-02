import { memoryOwnerKey } from "../../../domain/memory/index.js";
import { createId } from "../../../kernel/id.js";
import type {
  MemoryEvidenceRef,
  MemoryRecallInput,
  MemoryRecallPort,
  MemoryRecallSnapshot,
  RecalledMemory,
} from "../contracts.js";
import { resolveAdmissionFromPolicy } from "../policy/policy-snapshot.js";
import type { MemoryContentRepository } from "../store/content-repository.js";
import type { MemoryControlRepository } from "../store/control-repository.js";
import { lexicalMatchExpression } from "./lexical-projection.js";
/**
 * 真实 Recall 引擎（T22，《手册》6.2/7.6/10/16）。
 *
 * recall 返回是四个 Policy Gate 边界之一（7.1）：每次调用都经
 * resolveAdmissionFromPolicy 当次重算 admission（fail-closed），不缓存。
 * - effective=off：不读 store、不查询，直接返回空快照（12.1：off 不 Retrieve）；
 * - effective=shadow/active：都执行检索（shadow Retrieve=是，Inject=否；
 *   shadow/active 的分叉在 Context Provider 的 injection freeze 边界，不在本层）；
 * - FTS5 检索：lexical projection MATCH + bm25 排序（与 eval 工具链同源算法），
 *   scope 过滤（owner_key + status='active' + generation）在投影过滤与回表复核
 *   两处生效，跨 scope 泄漏恒为 0（10.2）；
 * - deadlineAt 只做简单时间检查：超时返回已得候选（不足则 no_hit），不阻塞主 Run
 *   （16.4）；FTS 查询异常返回 outcome='degraded'（与 no_hit 可区分，6.2）。
 *
 * 近期上下文（recentContext）按 10.1 允许进入确定性投影，但 T11 验证的检索基线
 * 只匹配当前用户请求，本引擎保持基线行为，不改写、不扩展查询。
 */

/** 《手册》10.6：通常 1–3 条，最多 4 条；Provider 未显式给上限时的默认值。 */
export const DEFAULT_RECALL_CANDIDATE_LIMIT = 4;

export type MemoryRecallEngineDeps = {
  readonly controlRepository: MemoryControlRepository;
  readonly contentRepository: MemoryContentRepository;
};

function toEvidenceRef(source: {
  readonly conversationId: string;
  readonly runId: string | null;
  readonly turnId: string | null;
  readonly fromOrdinal: number | null;
  readonly toOrdinal: number | null;
  readonly sourceRevision: number;
}): MemoryEvidenceRef {
  return {
    conversationId: source.conversationId,
    runId: source.runId ?? undefined,
    turnId: source.turnId ?? undefined,
    fromOrdinal: source.fromOrdinal ?? undefined,
    toOrdinal: source.toOrdinal ?? undefined,
    sourceRevision: source.sourceRevision,
  };
}

export function createRealMemoryRecallEngine(deps: MemoryRecallEngineDeps): MemoryRecallPort {
  return {
    async recall(input: MemoryRecallInput): Promise<MemoryRecallSnapshot> {
      const ownerKey = memoryOwnerKey(input.owner);
      const conversationId = input.conversationId ?? "";
      const candidateLimit = input.candidateLimit > 0 ? input.candidateLimit : DEFAULT_RECALL_CANDIDATE_LIMIT;
      const recallId = createId("memrecall");

      // 1. Policy Gate（recall 返回边界，当次重算，fail-closed）。
      const [policyRows, ownerLifecycle, conversationLifecycle] = await Promise.all([
        deps.controlRepository.readAllPolicy(),
        deps.controlRepository.getLifecycle(ownerKey),
        deps.controlRepository.getLifecycle(`conversation:${conversationId}`),
      ]);
      const admission = resolveAdmissionFromPolicy({
        owner: input.owner,
        conversationId,
        turnOverrideOff: false,
        policyRows,
        ownerLifecycle,
        conversationLifecycle,
      });

      const base = {
        recallId,
        policyRevision: admission.policyRevision,
        generation: admission.generation,
        scope: input.owner,
      };
      const readStoreRevision = () => deps.contentRepository.storeRevision(ownerKey);

      // off：不读 store、不查询（12.1 off 不 Retrieve；scope 不确定即 fail closed）。
      if (admission.effective === "off") {
        return { ...base, storeRevision: "0", candidates: [], outcome: "no_hit" };
      }

      // deadline 预检：已过期就不启动检索（16.4 超时返回空，不阻塞主 Run）。
      if (Date.now() >= input.deadlineAt) {
        return { ...base, storeRevision: await readStoreRevision(), candidates: [], outcome: "no_hit" };
      }

      // 2. lexical projection → FTS5 MATCH（空投影 = 查询无可用 token，no-hit）。
      const match = lexicalMatchExpression(input.currentUserText);
      if (match === "") {
        return { ...base, storeRevision: await readStoreRevision(), candidates: [], outcome: "no_hit" };
      }

      // 3. FTS 检索（scope 过滤 + bm25）。FTS 异常 = degraded，不是 no_hit。
      let rankedRecords;
      try {
        rankedRecords = await deps.contentRepository.searchActiveByProjection({
          ownerKey,
          match,
          generation: admission.generation,
          limit: candidateLimit,
        });
      } catch {
        return { ...base, storeRevision: await readStoreRevision(), candidates: [], outcome: "degraded" };
      }

      // 4. 组装有界候选（provenance 从 memory_record_source 读；不再携带分数/rowid）。
      const candidates: RecalledMemory[] = [];
      for (const record of rankedRecords) {
        if (candidates.length >= candidateLimit) break;
        if (Date.now() >= input.deadlineAt) break;
        const sources = await deps.contentRepository.listSources(record.recordId, record.revision);
        candidates.push({
          ref: { id: record.recordId, revision: record.revision },
          scope: input.owner,
          kind: record.kind,
          text: record.modelText,
          provenance: sources.map(toEvidenceRef),
          evidenceClass: record.evidenceClass,
          confirmation: record.confirmation,
          updatedAt: record.updatedAt,
        });
      }

      return {
        ...base,
        storeRevision: await readStoreRevision(),
        candidates,
        outcome: candidates.length === 0 ? "no_hit" : "ok",
      };
    },
  };
}
