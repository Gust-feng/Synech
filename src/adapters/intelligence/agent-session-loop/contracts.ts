import type {
  CompactionSettings,
  ExecutionEnv,
  Session,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { ToolOperationType } from "../../../domain/tools/index.js";
import type { ModelProviderPayloadTransformer } from "../model-provider-binding.js";

export type AgentSessionLoopOptions = {
  readonly executionEnvironment: ExecutionEnv;
  readonly modelRegistry: Models;
  readonly selectedModel: Model<Api>;
  /** Frozen Ordinary capability; Pi model.input remains the transport projection. */
  readonly supportsVisionInput?: boolean;
  readonly agentSession: Session;
  readonly thinkingLevel?: ThinkingLevel;
  readonly transformProviderPayload?: ModelProviderPayloadTransformer;
  readonly toolDefinitionTokenCounter?: AgentSessionToolDefinitionTokenCounter;
  readonly onProviderToolDefinitionMetrics?: AgentSessionToolDefinitionMetricsObserver;
  readonly compactionSettings?: CompactionSettings;
  /**
   * 每次冻结前的记忆背景供给复核（0.6.0 正式设计 §9.3）。返回 undefined 表示当前
   * 无可供给背景（未绑定/被撤销/关闭）；返回文本时作为独立临时 contribution 插入
   * provider 上下文，不写入 Session 持久化。
   */
  readonly resolveMemoryBackgroundBlock?: () => Promise<string | undefined>;
  /** Injectable clock for request timing observation. */
  readonly now?: () => number;
};

export type AgentSessionToolDefinitionTokenCounter = (serializedDefinition: string) => number;

export type AgentSessionToolDefinitionMetric = {
  readonly toolName: string;
  readonly operationType: ToolOperationType;
  readonly definitionHash: string;
  readonly definitionTokens: number;
};

export type AgentSessionToolDefinitionMetrics = {
  readonly toolCount: number;
  readonly totalTokens: number;
  readonly tools: readonly AgentSessionToolDefinitionMetric[];
};

export type AgentSessionToolDefinitionMetricsObserver = (
  metrics: AgentSessionToolDefinitionMetrics,
) => void;
