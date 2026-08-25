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
