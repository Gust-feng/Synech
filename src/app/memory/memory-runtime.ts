import { createControlMemoryLifecycle } from "./lifecycle/control-lifecycle.js";
import {
  createNoopMemoryCaptureRuntime,
  createNoopMemoryContextProvider,
} from "./noop.js";
import { createCaptureRuntime } from "./capture/capture-runtime.js";
import {
  createInMemoryShadowInjectionLog,
  createRealMemoryContextProvider,
  type MemoryShadowInjectionLog,
} from "./recall/context-provider.js";
import { createRealMemoryRecallEngine } from "./recall/recall-engine.js";
import type { MemoryContentRepository } from "./store/content-repository.js";
import type { MemoryControlRepository } from "./store/control-repository.js";
import type {
  MemoryCaptureRuntime,
  MemoryContextProvider,
  MemoryLifecycle,
  OrdinaryEvidenceReader,
} from "./contracts.js";

/**
 * Memory Feature 运行时装配。
 * - ContextProvider：contentRepository 齐备时装配真实实现（Real Recall 引擎 +
 *   injection freeze 边界的 Policy Gate + FTS5 lexical 投影检索）；shadow 恒空
 *   贡献并记录 wouldInject 诊断，active 才真正注入候选（T22，语义见
 *   recall/context-provider.ts）；缺省（无可写内容表）回退 No-op，保留"可缺席组合"；
 * - Lifecycle 恒为 Durable（memory/1 迁移一旦注册就不再满足 ProvenAbsent 前提）；
 * - CaptureRuntime：当 contentRepository + evidenceReader 齐备时装配真实 Capture
 *   （Policy Gate→连续证据窗→durable job）；缺省回退 No-op。
 */
export type MemoryRuntime = {
  readonly contextProvider: MemoryContextProvider;
  readonly captureRuntime: MemoryCaptureRuntime;
  readonly lifecycle: MemoryLifecycle;
  /**
   * shadow wouldInject 诊断（进程内存有界缓冲）；仅真实 Provider 装配时存在。
   * 正式 trace 表待 Developer Diagnostics 卡（手册 8.6/20），不进当前 schema。
   */
  readonly shadowInjectionLog: MemoryShadowInjectionLog | undefined;
};

export type CreateMemoryRuntimeInput = {
  readonly controlRepository: MemoryControlRepository;
  /** 提供则启用真实 Capture 与真实 Recall/注入；缺省回退 No-op capture/provider。 */
  readonly contentRepository?: MemoryContentRepository;
  readonly evidenceReader?: OrdinaryEvidenceReader;
};

export function createMemoryRuntime(input: CreateMemoryRuntimeInput): MemoryRuntime {
  const realCaptureAvailable = input.contentRepository !== undefined && input.evidenceReader !== undefined;
  const realRecallAvailable = input.contentRepository !== undefined;
  const shadowInjectionLog = realRecallAvailable ? createInMemoryShadowInjectionLog() : undefined;
  return {
    contextProvider: realRecallAvailable
      ? createRealMemoryContextProvider({
          controlRepository: input.controlRepository,
          recallEngine: createRealMemoryRecallEngine({
            controlRepository: input.controlRepository,
            contentRepository: input.contentRepository as MemoryContentRepository,
          }),
          shadowInjectionLog,
        })
      : createNoopMemoryContextProvider(),
    captureRuntime: realCaptureAvailable
      ? createCaptureRuntime({
          controlRepository: input.controlRepository,
          contentRepository: input.contentRepository as MemoryContentRepository,
          evidenceReader: input.evidenceReader as OrdinaryEvidenceReader,
        })
      : createNoopMemoryCaptureRuntime(),
    lifecycle: createControlMemoryLifecycle(input.controlRepository),
    shadowInjectionLog,
  };
}
