import { createControlMemoryLifecycle } from "./lifecycle/control-lifecycle.js";
import {
  createNoopMemoryCaptureRuntime,
  createNoopMemoryContextProvider,
} from "./noop.js";
import type { MemoryControlRepository } from "./store/control-repository.js";
import type {
  MemoryCaptureRuntime,
  MemoryContextProvider,
  MemoryLifecycle,
} from "./contracts.js";

/**
 * Memory Feature 运行时装配。Phase 1：
 * - ContextProvider / CaptureRuntime 为 No-op（Recall 恒空贡献、信号恒 skipped），
 *   用于走通装配、注入插槽与 durable 控制状态，主链路模型可见输出零变化；
 * - Lifecycle 为 Durable（基于控制表的 fence/generation 两阶段删除），因为
 *   memory/1 迁移一旦注册就不再满足 ProvenAbsent 的"从未建 schema"前提。
 * Phase 3 起把 Provider/Capture 换成 Real 实现，本装配签名不变。
 */
export type MemoryRuntime = {
  readonly contextProvider: MemoryContextProvider;
  readonly captureRuntime: MemoryCaptureRuntime;
  readonly lifecycle: MemoryLifecycle;
};

export function createMemoryRuntime(input: {
  readonly controlRepository: MemoryControlRepository;
}): MemoryRuntime {
  return {
    contextProvider: createNoopMemoryContextProvider(),
    captureRuntime: createNoopMemoryCaptureRuntime(),
    lifecycle: createControlMemoryLifecycle(input.controlRepository),
  };
}
