import { createControlMemoryLifecycle } from "./lifecycle/control-lifecycle.js";
import {
  createNoopMemoryBackgroundPort,
  createNoopMemoryCaptureRuntime,
  createNoopMemoryHistoryQueryPort,
  createUnavailableMemoryLifecycle,
} from "./noop.js";
import { createMemoryCaptureRuntime } from "./capture/capture-runtime.js";
import { createMemoryBackgroundPort } from "./background/background-port.js";
import { createMemoryHistoryQueryPort } from "./history/history-query-port.js";
import type { MemoryDocumentRepository } from "./store/content-repository.js";
import type { MemoryControlRepository } from "./store/control-repository.js";
import type {
  HistoryConversationLookup,
} from "./history/history-query-port.js";
import type {
  MemoryBackgroundPort,
  MemoryCaptureRuntime,
  HistoryQueryPort,
  MemoryLifecycle,
  OrdinaryEvidenceReader,
} from "./contracts.js";

/**
 * Memory Feature 运行时装配（0.6.0 文档产物）。
 * - BackgroundPort：绑定读取 + 每次 freeze 的供给复核（effective=active + generation
 *   + validity）；缺省（无文档仓储）回退 Noop，保留"可缺席组合"；
 * - HistoryQueryPort：search_history / read_history 的查询逻辑（scope 注入、回表复核、
 *   coverage 如实报告）；
 * - CaptureRuntime：稳定信号接单（Policy Gate → transcript 索引增量 → 每会话待办）；
 * - Lifecycle：文档仓储齐备时为 Durable；control-only 组合注册 unavailable，
 *   不把无法清理数据误报成成功；ProvenAbsent 只由明确举证的新安装装配。
 */
export type MemoryRuntime = {
  readonly backgroundPort: MemoryBackgroundPort;
  readonly historyQueryPort: HistoryQueryPort;
  readonly captureRuntime: MemoryCaptureRuntime;
  readonly lifecycle: MemoryLifecycle;
};

export type CreateMemoryRuntimeInput = {
  readonly controlRepository: MemoryControlRepository;
  /** 文档仓储 + 证据读取口齐备时装配真实实现；缺省回退 Noop。 */
  readonly documentRepository?: MemoryDocumentRepository;
  readonly evidenceReader?: OrdinaryEvidenceReader;
  /** 历史查询的会话身份/标题查找（宿主经 Ordinary 只读 queries 适配）。 */
  readonly conversationLookup?: HistoryConversationLookup;
};

export function createMemoryRuntime(input: CreateMemoryRuntimeInput): MemoryRuntime {
  const documentRepository = input.documentRepository;
  const evidenceReader = input.evidenceReader;
  const realAvailable = documentRepository !== undefined && evidenceReader !== undefined;
  const conversationLookup: HistoryConversationLookup = input.conversationLookup ?? {
    async resolveConversationOwner() {
      return undefined;
    },
  };
  return {
    backgroundPort: realAvailable
      ? createMemoryBackgroundPort({
          controlRepository: input.controlRepository,
          documentRepository,
        })
      : createNoopMemoryBackgroundPort(),
    historyQueryPort: realAvailable
      ? createMemoryHistoryQueryPort({
          controlRepository: input.controlRepository,
          documentRepository,
          evidenceReader,
          conversationLookup,
        })
      : createNoopMemoryHistoryQueryPort(),
    captureRuntime: realAvailable
      ? createMemoryCaptureRuntime({
          controlRepository: input.controlRepository,
          documentRepository,
          evidenceReader,
        })
      : createNoopMemoryCaptureRuntime(),
    lifecycle: documentRepository === undefined
      ? createUnavailableMemoryLifecycle()
      : createControlMemoryLifecycle(input.controlRepository, { documentRepository }),
  };
}
