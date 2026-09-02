import { createControlMemoryLifecycle } from "./lifecycle/control-lifecycle.js";
import {
  createNoopMemoryCaptureRuntime,
  createNoopMemoryContextProvider,
  createUnavailableMemoryLifecycle,
} from "./noop.js";
import { createCaptureRuntime } from "./capture/capture-runtime.js";
import {
  createInMemoryShadowInjectionLog,
  createInMemoryMemoryRecallTraceLog,
  createRealMemoryContextProvider,
  type MemoryShadowInjectionLog,
  type MemoryRecallTraceLog,
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
 *   贡献并记录 wouldInject 诊断，active 才真正注入候选（语义见
 *   recall/context-provider.ts）；缺省（无可写内容表）回退 No-op，保留"可缺席组合"；
 * - Lifecycle：内容仓储齐备时为 Durable；control-only 组合注册 unavailable，
 *   不把无法清理数据误报成成功；ProvenAbsent 只由明确举证的新安装装配。
 * - CaptureRuntime：当 contentRepository + evidenceReader 齐备时装配真实 Capture
 *   （Policy Gate→连续证据窗→durable job）；缺省回退 No-op。
 */
export type MemoryRuntime = {
  readonly contextProvider: MemoryContextProvider;
  readonly captureRuntime: MemoryCaptureRuntime;
  readonly lifecycle: MemoryLifecycle;
  /**
   * Shadow wouldInject 诊断（进程内存有界缓冲）；仅真实 Provider 装配时存在。
   * trace 同样是有界运行时诊断，不复制正文，不进入 Product schema。
   */
  readonly shadowInjectionLog: MemoryShadowInjectionLog | undefined;
  readonly traceLog: MemoryRecallTraceLog | undefined;
};

export type CreateMemoryRuntimeInput = {
  readonly controlRepository: MemoryControlRepository;
  /** 提供则启用真实 Capture 与真实 Recall/注入；缺省回退 No-op capture/provider。 */
  readonly contentRepository?: MemoryContentRepository;
  readonly evidenceReader?: OrdinaryEvidenceReader;
};

export function createMemoryRuntime(input: CreateMemoryRuntimeInput): MemoryRuntime {
  const contentRepository = input.contentRepository;
  const evidenceReader = input.evidenceReader;
  const realCaptureAvailable = contentRepository !== undefined && evidenceReader !== undefined;
  const realRecallAvailable = contentRepository !== undefined;
  const shadowInjectionLog = realRecallAvailable ? createInMemoryShadowInjectionLog() : undefined;
  const traceLog = realRecallAvailable ? createInMemoryMemoryRecallTraceLog() : undefined;
  return {
    contextProvider: realRecallAvailable
      ? createRealMemoryContextProvider({
          controlRepository: input.controlRepository,
          recallEngine: createRealMemoryRecallEngine({
            controlRepository: input.controlRepository,
            contentRepository,
          }),
          shadowInjectionLog,
          traceLog,
        })
      : createNoopMemoryContextProvider(),
    captureRuntime: realCaptureAvailable
      ? createCaptureRuntime({
          controlRepository: input.controlRepository,
          contentRepository,
          evidenceReader,
        })
      : createNoopMemoryCaptureRuntime(),
    lifecycle: contentRepository === undefined
      ? createUnavailableMemoryLifecycle()
      : createControlMemoryLifecycle(input.controlRepository, { contentRepository }),
    shadowInjectionLog,
    traceLog,
  };
}
