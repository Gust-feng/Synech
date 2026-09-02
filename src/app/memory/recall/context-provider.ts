import { memoryOwnerKey } from "../../../domain/memory/index.js";
import { createId } from "../../../kernel/id.js";
import type {
  MemoryContextContribution,
  MemoryContextProvider,
  MemoryContributeInput,
  MemoryRecallPort,
} from "../contracts.js";
import { resolveAdmissionFromPolicy } from "../policy/policy-snapshot.js";
import type { MemoryControlRepository } from "../store/control-repository.js";

/**
 * 真实 MemoryContextProvider（T22）：injection freeze 边界（《手册》7.1 四边界之一）。
 *
 * shadow/active 的唯一分叉点在本文件的 contribute 内（12.1 Rollout 模式表）：
 * - effective=off：不 Recall、不注入（直接空贡献）；
 * - effective=shadow：照常 Recall（Retrieve=是）但恒不注入（Inject=否，entries 恒空），
 *   同时把 wouldInject 候选记入诊断层，供 Developer Shadow 评测对照；
 * - effective=active：Recall 并把候选映射为 entries 真正注入（modelText 是唯一
 *   进入 Prompt 的字段，provenance 只走 internalRefs）。
 *
 * 每次 contribute 前经 resolveAdmissionFromPolicy 当次重算（fail-closed，不缓存
 * recall 边界的旧结论）；off/shadow 恒空贡献使下游渲染与无记忆时字节一致。
 */

/**
 * wouldInject 诊断：shadow 模式下"若 active 本会注入的候选"。
 * 正式 trace 表（RetrievalTrace，《手册》8.6/20）待 Developer Diagnostics 卡；
 * 当前只是进程内存有界缓冲，不进任何 schema，进程退出即丢。
 */
export type MemoryShadowInjectionEntry = {
  readonly at: number;
  readonly ownerKey: string;
  readonly conversationId: string | undefined;
  readonly recallId: string;
  readonly policyRevision: string;
  readonly generation: number;
  readonly candidateRefs: readonly { readonly id: string; readonly revision: number }[];
};

export interface MemoryShadowInjectionLog {
  record(entry: MemoryShadowInjectionEntry): void;
  snapshot(): readonly MemoryShadowInjectionEntry[];
}

/** 有界 FIFO（默认保留最近 100 条），只作诊断，不参与任何程序分支。 */
export function createInMemoryShadowInjectionLog(limit = 100): MemoryShadowInjectionLog {
  const entries: MemoryShadowInjectionEntry[] = [];
  return {
    record(entry) {
      entries.push(entry);
      if (entries.length > limit) entries.splice(0, entries.length - limit);
    },
    snapshot() {
      return [...entries];
    },
  };
}

export type RealMemoryContextProviderDeps = {
  readonly controlRepository: MemoryControlRepository;
  readonly recallEngine: MemoryRecallPort;
  /** 缺省时自建有界内存缓冲；装配方可注入共享实例做诊断聚合。 */
  readonly shadowInjectionLog?: MemoryShadowInjectionLog;
  /** 《手册》10.6 实验起点：最多 4 条。 */
  readonly candidateLimit?: number;
};

function emptyContribution(
  owner: MemoryContributeInput["owner"],
  ownerKey: string,
  policyRevision: string,
  generation: number,
): MemoryContextContribution {
  return {
    source: "implicit_memory",
    snapshot: {
      recallId: createId("memrecall"),
      storeRevision: "0",
      policyRevision,
      generation,
      ownerKey,
    },
    entries: [],
  };
}

export function createRealMemoryContextProvider(deps: RealMemoryContextProviderDeps): MemoryContextProvider {
  const shadowInjectionLog = deps.shadowInjectionLog ?? createInMemoryShadowInjectionLog();
  return {
    async contribute(input: MemoryContributeInput): Promise<MemoryContextContribution> {
      const ownerKey = memoryOwnerKey(input.owner);
      const conversationKey = `conversation:${input.conversationId ?? ""}`;

      // 1. injection freeze 边界的当次 policy 重算（fail-closed，不复用 recall 结论）。
      const [policyRows, ownerLifecycle, conversationLifecycle] = await Promise.all([
        deps.controlRepository.readAllPolicy(),
        deps.controlRepository.getLifecycle(ownerKey),
        deps.controlRepository.getLifecycle(conversationKey),
      ]);
      const admission = resolveAdmissionFromPolicy({
        owner: input.owner,
        conversationId: input.conversationId ?? "",
        turnOverrideOff: false,
        policyRows,
        ownerLifecycle,
        conversationLifecycle,
      });

      // 2. off：不 Recall、不注入。
      if (admission.effective === "off") {
        return emptyContribution(input.owner, ownerKey, admission.policyRevision, admission.generation);
      }

      // 3. shadow/active 都 Recall（ Retrieve=是）；deadline/candidateLimit 由本层决定。
      const snapshot = await deps.recallEngine.recall({
        owner: input.owner,
        conversationId: input.conversationId,
        currentUserText: input.currentUserText,
        candidateLimit: deps.candidateLimit ?? 4,
        deadlineAt: input.deadlineAt,
      });

      // 4. shadow：恒空贡献 + wouldInject 诊断（有候选才记录）。
      if (admission.effective === "shadow") {
        if (snapshot.candidates.length > 0) {
          shadowInjectionLog.record({
            at: Date.now(),
            ownerKey,
            conversationId: input.conversationId,
            recallId: snapshot.recallId,
            policyRevision: snapshot.policyRevision,
            generation: snapshot.generation,
            candidateRefs: snapshot.candidates.map((candidate) => candidate.ref),
          });
        }
        return {
          source: "implicit_memory",
          snapshot: {
            recallId: snapshot.recallId,
            storeRevision: snapshot.storeRevision,
            policyRevision: snapshot.policyRevision,
            generation: snapshot.generation,
            ownerKey,
          },
          entries: [],
        };
      }

      // 5. active：候选真正注入；modelText 是唯一模型可见字段（10.3 候选与注入分离）。
      return {
        source: "implicit_memory",
        snapshot: {
          recallId: snapshot.recallId,
          storeRevision: snapshot.storeRevision,
          policyRevision: snapshot.policyRevision,
          generation: snapshot.generation,
          ownerKey,
        },
        entries: snapshot.candidates.map((candidate) => ({
          ref: candidate.ref,
          kind: candidate.kind,
          evidenceClass: candidate.evidenceClass,
          confirmation: candidate.confirmation,
          updatedAt: candidate.updatedAt,
          modelText: candidate.text,
          internalRefs: candidate.provenance,
        })),
      };
    },
  };
}
