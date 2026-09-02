import { createControlMemoryLifecycle } from "./lifecycle/control-lifecycle.js";
import {
  createNoopMemoryCaptureRuntime,
  createNoopMemoryContextProvider,
} from "./noop.js";
import { createCaptureRuntime } from "./capture/capture-runtime.js";
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
 * - ContextProvider 仍为 No-op（Recall 恒空贡献；M3 只做 Capture/Consolidation 的写入侧，
 *   注入侧到 Shadow/Canary 才切换）；
 * - Lifecycle 恒为 Durable（memory/1 迁移一旦注册就不再满足 ProvenAbsent 前提）；
 * - CaptureRuntime：当 contentRepository + evidenceReader 齐备时装配真实 Capture
 *   （Policy Gate→连续证据窗→durable job）；缺省回退 No-op，保留"可缺席组合"。
 */
export type MemoryRuntime = {
  readonly contextProvider: MemoryContextProvider;
  readonly captureRuntime: MemoryCaptureRuntime;
  readonly lifecycle: MemoryLifecycle;
};

export type CreateMemoryRuntimeInput = {
  readonly controlRepository: MemoryControlRepository;
  /** 提供则启用真实 Capture；缺省（无可写内容表/证据读取口）回退 No-op capture。 */
  readonly contentRepository?: MemoryContentRepository;
  readonly evidenceReader?: OrdinaryEvidenceReader;
};

export function createMemoryRuntime(input: CreateMemoryRuntimeInput): MemoryRuntime {
  const realCaptureAvailable = input.contentRepository !== undefined && input.evidenceReader !== undefined;
  return {
    contextProvider: createNoopMemoryContextProvider(),
    captureRuntime: realCaptureAvailable
      ? createCaptureRuntime({
          controlRepository: input.controlRepository,
          contentRepository: input.contentRepository as MemoryContentRepository,
          evidenceReader: input.evidenceReader as OrdinaryEvidenceReader,
        })
      : createNoopMemoryCaptureRuntime(),
    lifecycle: createControlMemoryLifecycle(input.controlRepository),
  };
}
