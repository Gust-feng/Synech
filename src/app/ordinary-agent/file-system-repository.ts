import { isDeepStrictEqual } from "node:util";
import { runModelConfiguration } from "./run-model-configuration.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { renameWithRetry } from "../../kernel/fs/atomic-write.js";
import { isNodeError, toPersistedJsonShape } from "../../kernel/values/index.js";
import { cloneToolInputSchema, isCanonicalToolName, toolInvocationId, type ToolInputSchema } from "../../domain/tools/index.js";
import type { ConfirmationRequest } from "../../domain/confirmation/contracts.js";
import { modelProviderConnectionSettingsSchema } from "../../domain/config/model-connection-settings-schema.js";
import { modelConfigurationSchema, modelSettingsSchema } from "../../domain/config/model-configuration-schema.js";
import {
  ORDINARY_RUN_SCHEMA_VERSION,
  OrdinaryFeatureError,
  type OrdinaryRunRepository,
  type OrdinaryRunRecoveryInventory,
  type OrdinaryRunSnapshotDocument,
  type OrdinaryRunState,
  type OrdinaryRunSummary,
} from "./contracts.js";
import { assertOrdinaryToolFactGraph } from "./state.js";
import { isTerminalStatus } from "./run-lifecycle-policy.js";

const MANIFEST_SCHEMA_VERSION = "ordinary-run-manifest/v1" as const;

export class OrdinaryRunSnapshotIncompatibleError extends Error {
  readonly code = "ordinary_run_snapshot_incompatible" as const;

  constructor(readonly runId: string, reason: string) {
    super(`Ordinary run snapshot ${runId} is incompatible with ${ORDINARY_RUN_SCHEMA_VERSION}: ${reason}`);
    this.name = "OrdinaryRunSnapshotIncompatibleError";
  }
}

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.string(), z.number().finite(), z.boolean(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema),
]));
const modelAttachmentRefSchema = z.object({
  kind: z.literal("image"),
  attachmentId: z.string().min(1).optional(),
  inputRef: z.string().min(1).optional(),
  mimeType: z.string().min(1),
  byteLength: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
const toolInputSchemaSchema = z.custom<ToolInputSchema>((value) => {
  try {
    cloneToolInputSchema(value);
    return true;
  } catch {
    return false;
  }
}, "a complete object tool input schema is required");
const confirmationSchema = z.object({
  confirmationId: z.string().min(1), invocationId: z.string().min(1), conversationId: z.string().optional(),
  title: z.string(), actionSummary: z.string(), consequence: z.string().optional(),
  affectedResources: z.array(z.string()), riskLevel: z.enum(["low", "medium", "high"]),
  resumeAvailability: z.enum(["live", "lost_after_restart"]).optional(), requestedAt: z.string().min(1),
  expiresAt: z.string().optional(), sourceRefs: z.array(z.string()),
}).strict();
const confirmationDecisionSchema = z.object({
  confirmationId: z.string().min(1),
  decision: z.enum(["approve_once", "deny", "guidance"]), decidedAt: z.string().min(1),
  guidance: z.string().optional(),
}).strict();
const usageSchema = z.object({
  requestCount: z.number().int().nonnegative().optional(),
  inputTokens: z.number().finite().nonnegative().optional(),
  outputTokens: z.number().finite().nonnegative().optional(),
  totalTokens: z.number().finite().nonnegative().optional(),
  cachedInputTokens: z.number().finite().nonnegative().optional(),
  cacheWriteInputTokens: z.number().finite().nonnegative().optional(),
  uncachedInputTokens: z.number().finite().nonnegative().optional(),
  reasoningOutputTokens: z.number().finite().nonnegative().optional(),
  estimatedCostUsd: z.number().finite().nonnegative().optional(),
  latencyMs: z.number().finite().nonnegative().optional(),
  firstTokenLatencyMs: z.number().finite().nonnegative().optional(),
  outputDurationMs: z.number().finite().nonnegative().optional(),
  outputTokensPerSecond: z.number().finite().nonnegative().optional(),
  latestAgentRequest: z.object({
    inputTokens: z.number().finite().nonnegative().optional(),
    outputTokens: z.number().finite().nonnegative().optional(),
    totalTokens: z.number().finite().nonnegative().optional(),
    cachedInputTokens: z.number().finite().nonnegative().optional(),
    cacheWriteInputTokens: z.number().finite().nonnegative().optional(),
    uncachedInputTokens: z.number().finite().nonnegative().optional(),
    reasoningOutputTokens: z.number().finite().nonnegative().optional(),
  }).strict().optional(),
}).strict();
const toolMetricHistogramSchema = z.object({
  bounds: z.array(z.number().finite().nonnegative()),
  counts: z.array(z.number().int().nonnegative()),
  count: z.number().int().nonnegative(),
  sum: z.number().finite().nonnegative(),
  max: z.number().finite().nonnegative(),
}).strict().superRefine((histogram, context) => {
  if (histogram.counts.length !== histogram.bounds.length + 1) {
    context.addIssue({ code: "custom", message: "histogram counts must include one overflow bucket", path: ["counts"] });
  }
  if (histogram.counts.reduce((sum, count) => sum + count, 0) !== histogram.count) {
    context.addIssue({ code: "custom", message: "histogram count must equal its bucket total", path: ["count"] });
  }
});
const toolMetricCountRecordSchema = z.record(z.string(), z.number().int().nonnegative());
const toolMetricsSchema = z.object({
  schemaVersion: z.literal("ordinary-tool-metrics/v1"),
  definitionRequestCount: z.number().int().nonnegative(),
  definitionToolCount: toolMetricHistogramSchema,
  totalDefinitionTokens: toolMetricHistogramSchema,
  metricsDroppedCount: z.number().int().nonnegative(),
  tools: z.array(z.object({
    toolName: z.string().min(1),
    operationType: z.enum(["read-only", "read-write", "execute", "external-submit"]),
    definitionHash: z.string().min(1).optional(),
    definitionTokens: toolMetricHistogramSchema,
    calls: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    approvalRequired: z.number().int().nonnegative(),
    retained: z.number().int().nonnegative(),
    retentionFailures: z.number().int().nonnegative(),
    retentionAvailability: toolMetricCountRecordSchema,
    retentionMs: toolMetricHistogramSchema,
    continuationsOffered: z.number().int().nonnegative(),
    continuationsCompleted: z.number().int().nonnegative(),
    continuationReadFailures: z.number().int().nonnegative(),
    continuationExpired: z.number().int().nonnegative(),
    continuationChars: z.number().int().nonnegative(),
    inputTokens: toolMetricHistogramSchema,
    rawBodyTokens: toolMetricHistogramSchema,
    rawEnvelopeTokens: toolMetricHistogramSchema,
    finalEnvelopeTokens: toolMetricHistogramSchema,
    queueWaitMs: toolMetricHistogramSchema,
    executionMs: toolMetricHistogramSchema,
    continuationPages: toolMetricHistogramSchema,
    outputChars: z.number().int().nonnegative(),
    outputBytes: z.number().int().nonnegative(),
    maxActive: z.number().int().nonnegative(),
    queuedCancelled: z.number().int().nonnegative(),
    retentionReasons: toolMetricCountRecordSchema,
  }).strict()),
}).strict();
const canonicalToolNameSchema = z.string().min(1).refine(isCanonicalToolName, {
  message: "tool identity must be a canonical provider-portable name",
});
const pendingNestedToolCallSchema = z.object({
  providerCallId: z.string().min(1),
  invocationId: z.string().min(1),
  parentInvocationId: z.string().min(1),
  toolName: canonicalToolNameSchema,
  input: jsonValueSchema.optional(),
}).strict();
const toolCallSchema = z.object({
  providerCallId: z.string().min(1), invocationId: z.string().min(1), parentInvocationId: z.string().min(1).optional(), toolName: canonicalToolNameSchema, input: jsonValueSchema.optional(),
  output: jsonValueSchema.optional(), status: z.enum(["completed", "failed", "approval_required", "cancelled"]),
  modelAttachmentRefs: z.array(modelAttachmentRefSchema).optional(),
  error: z.string().optional(), errorDomain: z.string().optional(), errorFacts: z.record(z.string(), jsonValueSchema).optional(),
  failureAttribution: z.enum(["schema_validation", "execution_failure"]).optional(),
  delegatedExecution: z.object({
    modelRounds: z.number().int().nonnegative(),
    toolCallCount: z.number().int().nonnegative(),
    usage: usageSchema,
  }).strict().optional(),
  durationMs: z.number().finite().nonnegative(), confirmationRequest: confirmationSchema.optional(),
}).strict().superRefine((result, context) => {
  if (result.status === "approval_required") {
    if (result.confirmationRequest === undefined) {
      context.addIssue({ code: "custom", message: "approval result requires its confirmation request", path: ["confirmationRequest"] });
    } else if (result.confirmationRequest.invocationId !== result.invocationId) {
      context.addIssue({ code: "custom", message: "confirmation request does not match the tool invocation identity", path: ["confirmationRequest", "invocationId"] });
    }
  } else if (result.confirmationRequest !== undefined) {
    context.addIssue({ code: "custom", message: "resolved tool result cannot retain a confirmation request", path: ["confirmationRequest"] });
  }
  if (result.failureAttribution !== undefined && result.status !== "failed") {
    context.addIssue({ code: "custom", message: "failure attribution requires a failed tool result", path: ["failureAttribution"] });
  }
});
const configSchema = z.object({
  profileId: z.string().min(1), providerKind: z.literal("openai_compatible"),
  protocolKind: z.enum(["anthropic_messages", "openai_responses", "openai_compatible_chat_completions", "native"]),
  baseUrl: z.string(), defaultAiMode: z.enum(["none", "anthropic-messages", "openai-compatible", "openai-responses", "native"]),
  label: z.string().optional(),
  logoDataUrl: z.string().optional(),
  model: z.string().optional(),
  modelSettings: modelSettingsSchema.optional(),
  openAI: z.object({
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
    reasoningSummary: z.enum(["auto", "concise", "detailed"]).optional(),
    textVerbosity: z.enum(["low", "medium", "high"]).optional(),
    serviceTier: z.enum(["auto", "default", "flex", "priority"]).optional(),
    truncation: z.enum(["auto", "disabled"]).optional(),
    parallelToolCalls: z.boolean().optional(),
    store: z.boolean().optional(),
  }).strict().optional(),
  piProviderId: z.string().min(1).optional(),
  connection: modelProviderConnectionSettingsSchema.optional(),
  enabled: z.boolean().optional(),
  secretUpdatedAt: z.string().optional(),
  secretRef: z.string(), secretConfigured: z.boolean(), updatedAt: z.string().min(1),
}).strict().superRefine((config, context) => {
  if (config.protocolKind !== "native") return;
  if (config.piProviderId === undefined) {
    context.addIssue({ code: "custom", message: "native connections require a provider identity", path: ["piProviderId"] });
  }
  if (config.connection === undefined) {
    context.addIssue({ code: "custom", message: "native connections require connection settings", path: ["connection"] });
  }
}).transform(runModelConfiguration);
const resolvedModelCapabilitiesSchema = z.object({
  facts: z.union([
    z.object({
      status: z.literal("confirmed"),
      piProviderId: z.string().min(1),
      modelId: z.string(),
      transport: z.enum(["anthropic_messages", "openai_compatible_chat_completions", "openai_responses", "native"]).optional(),
      contextWindowTokens: z.number().positive(),
      maxOutputTokens: z.number().positive(),
      supportsVisionInput: z.boolean(),
      supportsReasoningOutput: z.boolean(),
      thinkingLevels: z.array(z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
      supportsStrictToolSchemas: z.boolean(),
      supportsParallelToolCalls: z.boolean(),
    }).strict(),
    z.object({
      status: z.literal("unconfirmed"),
      modelId: z.string(),
    }).strict(),
  ]),
  configuration: modelConfigurationSchema.optional(),
  transport: z.enum(["anthropic_messages", "openai_compatible_chat_completions", "openai_responses", "native"]).optional(),
}).strict();
const capabilitySnapshotSchema = z.object({
  snapshotId: z.string().min(1), createdAt: z.string().min(1), activeModel: configSchema,
  modelCapabilities: resolvedModelCapabilitiesSchema,
  toolCatalog: z.object({
    scope: z.literal("agent-basic"),
    tools: z.array(z.object({
      name: z.string().min(1),
      description: z.string(),
      inputSchema: toolInputSchemaSchema,
      definitionHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
      enabled: z.boolean(),
      availability: z.enum(["available", "unavailable"]),
    }).passthrough()),
    allowedTools: z.array(z.string()),
  }).passthrough(),
  skillCatalog: z.array(z.object({ id: z.string().min(1), name: z.string(), description: z.string(), enabled: z.boolean() }).passthrough()),
  subAgentCatalog: z.array(z.object({ id: z.string().min(1), name: z.string(), description: z.string(), enabled: z.boolean() }).passthrough()),
  mcpCatalog: z.array(z.object({ serverId: z.string().min(1), enabled: z.boolean(), availability: z.string() }).passthrough()),
  executionRoot: z.string().min(1), warnings: z.array(z.string()),
}).passthrough();
const memoryOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("space"), id: z.string().min(1) }).strict(),
]);
const birthSchema = z.object({
  recordToolMetrics: z.boolean().optional(),
  instructions: z.string(), aiMode: z.enum(["none", "anthropic-messages", "openai-compatible", "openai-responses", "native"]), config: configSchema,
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  agentDefinitionRef: z.object({
    agentId: z.string().min(1), agentDisplayName: z.string(), promptRef: z.string().min(1), promptVersion: z.string().min(1),
    outputContractId: z.string().min(1), toolVisibilityProfileId: z.string().min(1), definitionHash: z.string().optional(),
  }).strict(),
  capabilitySnapshot: capabilitySnapshotSchema,
  memoryOwner: memoryOwnerSchema,
  ownerContext: z.string().max(16_000).optional(),
  collaborationRulesContext: z.string().max(4_256).optional(),
  informationAccess: z.object({
    web: z.object({
      provider: z.enum(["tavily", "exa", "zai", "metaso", "google", "bing", "model_builtin", "none"]),
      maxResults: z.number().nonnegative(), secretConfigured: z.boolean(), status: z.enum(["ready", "no-provider", "disabled"]), updatedAt: z.string(),
    }).passthrough(),
  }).passthrough(),
  accessPolicy: z.object({
    approvalMode: z.enum(["prompt", "bypass"]),
    filesystemScope: z.enum(["owner_only", "unrestricted"]),
  }).strict(),
}).strict();
const statusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("queued") }).strict(),
  z.object({ kind: z.literal("running") }).strict(),
  z.object({ kind: z.literal("awaiting_approval"), confirmationRequests: z.array(confirmationSchema).min(1), continuationAvailability: z.literal("live_only") }).strict(),
  z.object({ kind: z.literal("completed") }).strict(),
  z.object({ kind: z.literal("failed"), error: z.object({ code: z.string().min(1), message: z.string() }).strict() }).strict(),
  z.object({ kind: z.literal("cancelled"), reason: z.string() }).strict(),
  z.object({ kind: z.literal("blocked"), reason: z.object({ code: z.string().min(1), message: z.string() }).strict(), continueBy: z.literal("new_turn") }).strict(),
]);
const capabilityResolutionSchema = z.object({
  resolutionId: z.string().min(1),
  snapshotId: z.string().min(1),
  agentId: z.string().min(1),
  agentDisplayName: z.string(),
  toolVisibilityProfileId: z.string().min(1),
  capabilityPlan: z.object({
    protocolToolCallCapabilities: z.object({
      protocolKind: z.enum(["anthropic_messages", "openai_responses", "openai_compatible_chat_completions", "native"]),
      canSendToolDefinitions: z.boolean(),
      canReceiveToolCalls: z.boolean(),
      canRoundTripToolResults: z.boolean(),
    }).strict(),
    modelCapabilities: resolvedModelCapabilitiesSchema,
    canExposeModelTools: z.boolean(),
  }).strict(),
  allowedTools: z.array(z.string()),
  toolExposures: z.array(z.object({
    name: z.string().min(1), displayName: z.string(), enabled: z.boolean(), modelVisible: z.boolean(),
    scopes: z.array(z.enum(["agent-basic", "workspace", "mcp", "research"])),
    availability: z.enum(["available", "unavailable"]), riskLevel: z.enum(["low", "medium", "high"]),
    operationType: z.enum(["read-only", "read-write", "execute", "external-submit"]),
    fileOperation: z.enum(["create", "write", "append", "edit", "delete"]).optional(),
    requiresConfirmation: z.boolean(), confirmationPolicy: z.enum(["prompt", "full_access"]).optional(),
    reasonCode: z.enum([
      "model_tools_unsupported", "tool_disabled", "tool_unavailable", "not_in_run_scope", "permission_denied",
      "profile_hidden", "available_full_access", "available_requires_confirmation", "available",
      "no_executable_tool_runner", "executable_tool_missing", "tool_contract_mismatch",
      "selected_skill_resources_available", "selected_skill_resources_unavailable", "no_enabled_sub_agents",
    ]).optional(),
    reason: z.string(),
  }).strict()),
  enabledSkills: z.array(z.object({
    id: z.string().min(1), name: z.string(), description: z.string(), triggers: z.array(z.string()),
  }).passthrough()),
  warnings: z.array(z.string()),
  createdAt: z.string().min(1),
}).strict();
const sessionCheckpointRefSchema = z.object({
  sessionId: z.string().min(1),
  checkpointId: z.string().min(1),
  kind: z.enum([
    "run_started",
    "input_committed",
    "assistant_tool_calls_committed",
    "tool_results_committed",
    "compaction_committed",
    "assistant_response_committed",
  ]),
}).strict();
const eventBase = {
  eventId: z.string().min(1), runId: z.string().min(1), sequence: z.number().int().positive(), recordedAt: z.string().min(1),
};
const eventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("run.created") }).strict(),
  z.object({ ...eventBase, type: z.literal("run.started") }).strict(),
  z.object({
    ...eventBase,
    type: z.literal("model.output.completed"),
    modelRequestId: z.string().min(1),
    assistantCheckpoint: sessionCheckpointRefSchema,
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal("model.reasoning.completed"),
    modelRequestId: z.string().min(1),
    contentIndex: z.number().int().nonnegative(),
    content: z.string().min(1),
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal("context.compaction.completed"),
    compactionCheckpoint: sessionCheckpointRefSchema,
    tokensBefore: z.number().int().nonnegative(),
  }).strict(),
  z.object({ ...eventBase, type: z.literal("run.approval_requested"), confirmationRequests: z.array(confirmationSchema).min(1), invocationIds: z.array(z.string().min(1)) }).strict(),
  z.object({ ...eventBase, type: z.literal("run.approval_decided"), decision: confirmationDecisionSchema }).strict(),
  z.object({ ...eventBase, type: z.literal("run.completed"), invocationIds: z.array(z.string().min(1)) }).strict(),
  z.object({ ...eventBase, type: z.literal("run.failed"), code: z.string().min(1), invocationIds: z.array(z.string().min(1)) }).strict(),
  z.object({ ...eventBase, type: z.literal("run.cancelled"), reason: z.string(), invocationIds: z.array(z.string().min(1)) }).strict(),
  z.object({ ...eventBase, type: z.literal("run.blocked"), code: z.string().min(1) }).strict(),
]);
const sessionPhaseSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("not_started") }).strict(),
  z.object({
    phase: z.literal("started"),
    startCheckpoint: sessionCheckpointRefSchema.nullable(),
    compactionCheckpoints: z.array(sessionCheckpointRefSchema),
  }).strict(),
  z.object({
    phase: z.literal("rollbackable"),
    startCheckpoint: sessionCheckpointRefSchema.nullable(),
    endCheckpoint: sessionCheckpointRefSchema,
    compactionCheckpoints: z.array(sessionCheckpointRefSchema),
  }).strict(),
  z.object({
    phase: z.literal("completion_candidate"),
    startCheckpoint: sessionCheckpointRefSchema.nullable(),
    rollbackCheckpoint: sessionCheckpointRefSchema,
    assistantCheckpoint: sessionCheckpointRefSchema,
    compactionCheckpoints: z.array(sessionCheckpointRefSchema),
  }).strict(),
]);
const rawStateSchema = z.object({
  runId: z.string().min(1),
  sessionRef: z.object({
    sessionId: z.string().min(1),
    storageKey: z.string().min(1),
    sessionCwd: z.string().min(1),
    createdAt: z.string().min(1),
  }).strict(),
  turn: z.object({
    conversationId: z.string().min(1), ordinal: z.number().int().positive(),
    userTurnId: z.string().min(1), assistantTurnId: z.string().min(1), predecessorRunId: z.string().min(1).optional(),
    replacesRunId: z.string().min(1).optional(),
  }).strict(),
  input: z.object({
    userMessage: z.string(),
    context: z.object({
      contextRefs: z.array(z.object({
        attachmentId: z.string().optional(),
        ref: z.string().min(1),
        pathGranted: z.boolean().optional(),
        // server-side-only，与 pathGranted 同级：Space 授权引用自动注入的标记，
        // 请求解析不读取，只随 run 快照持久化供投影/恢复使用
        automaticSpaceReference: z.boolean().optional(),
        sourceIdentity: z.string().min(1).optional(),
        mountVersion: z.string().min(1).optional(),
        kind: z.enum(["file", "project", "web", "workspace"]),
        title: z.string().optional(),
        summary: z.string().optional(),
        metadata: z.object({
          byteLength: z.number().int().nonnegative().optional(),
          mimeType: z.string().optional(),
          available: z.boolean().optional(),
          truncated: z.boolean().optional(),
        }).strict().optional(),
        readonlyPreview: z.object({
          title: z.string().optional(),
          text: z.string(),
        }).strict().optional(),
      }).strict()).optional(),
      permissionBoundaryRefs: z.array(z.string()).optional(),
    }).strict().optional(),
  }).strict(),
  birth: birthSchema,
  status: statusSchema,
  session: sessionPhaseSchema,
  visibleAssistantText: z.string().optional(),
  pendingToolRound: z.object({
    checkpoint: sessionCheckpointRefSchema,
    providerCallIds: z.array(z.string().min(1)).min(1),
    invocationIds: z.array(z.string().min(1)).min(1),
  }).strict().optional(),
  pendingNestedToolCalls: z.array(pendingNestedToolCallSchema).min(1).optional(),
  toolCalls: z.array(toolCallSchema),
  toolResultRecordedAt: z.record(z.string(), z.string().min(1)),
  usage: usageSchema,
  toolMetrics: toolMetricsSchema.optional(),
  capabilityResolution: capabilityResolutionSchema.optional(),
  timeline: z.array(eventSchema).min(1),
  timestamps: z.object({ createdAt: z.string().min(1), updatedAt: z.string().min(1), terminalAt: z.string().optional() }).strict(),
}).strict().superRefine((state, context) => {
  state.timeline.forEach((event, index) => {
    if (event.runId !== state.runId || event.sequence !== index + 1) {
      context.addIssue({ code: "custom", message: "timeline identity or sequence is invalid", path: ["timeline", index] });
    }
  });
  const terminal = isTerminalStatus(state.status);
  if (terminal !== (state.timestamps.terminalAt !== undefined)) {
    context.addIssue({ code: "custom", message: "terminal status and terminalAt must agree", path: ["timestamps", "terminalAt"] });
  }
  if (state.pendingToolRound !== undefined) {
    const providerIds = state.pendingToolRound.providerCallIds;
    const pendingIds = state.pendingToolRound.invocationIds;
    if (providerIds.length !== pendingIds.length) {
      context.addIssue({ code: "custom", message: "pending provider and invocation identity counts differ", path: ["pendingToolRound"] });
    }
    if (new Set(providerIds).size !== providerIds.length) {
      context.addIssue({ code: "custom", message: "pending provider call identity is duplicated", path: ["pendingToolRound", "providerCallIds"] });
    }
    if (new Set(pendingIds).size !== pendingIds.length) {
      context.addIssue({ code: "custom", message: "pending tool invocation identity is duplicated", path: ["pendingToolRound", "invocationIds"] });
    }
    if (state.status.kind === "queued" || state.status.kind === "completed") {
      context.addIssue({ code: "custom", message: "run status cannot own a pending tool round", path: ["pendingToolRound"] });
    }
    if (state.session.phase !== "rollbackable") {
      context.addIssue({ code: "custom", message: "pending tool round requires a rollbackable Session prefix", path: ["session"] });
    }
  }
  if (state.pendingNestedToolCalls !== undefined &&
      (state.status.kind === "queued" || state.status.kind === "completed")) {
    context.addIssue({
      code: "custom",
      message: "run status cannot own pending nested tool calls",
      path: ["pendingNestedToolCalls"],
    });
  }
  const sessionRefs = state.session.phase === "not_started"
    ? []
    : [
        state.session.startCheckpoint,
        ...state.session.compactionCheckpoints,
        ...(state.session.phase === "rollbackable" ? [state.session.endCheckpoint] : []),
        ...(state.session.phase === "completion_candidate"
          ? [state.session.rollbackCheckpoint, state.session.assistantCheckpoint]
          : []),
      ].filter((ref) => ref !== null);
  if (state.pendingToolRound !== undefined) sessionRefs.push(state.pendingToolRound.checkpoint);
  if (sessionRefs.some((ref) => ref.sessionId !== state.sessionRef.sessionId)) {
    context.addIssue({ code: "custom", message: "run Session entry ref belongs to a different Session", path: ["session"] });
  }
  if (state.status.kind === "completed" &&
      (state.session.phase !== "rollbackable" || state.pendingToolRound !== undefined)) {
    context.addIssue({ code: "custom", message: "completed run requires a rollbackable Session end leaf", path: ["session"] });
  }
  if (state.session.phase === "completion_candidate" && state.pendingToolRound !== undefined) {
    context.addIssue({ code: "custom", message: "Session response candidate cannot coexist with a pending tool round", path: ["session"] });
  }
  if (state.turn.predecessorRunId === state.runId) {
    context.addIssue({ code: "custom", message: "a run cannot be its own predecessor", path: ["turn", "predecessorRunId"] });
  }
  if ((state.turn.predecessorRunId === undefined) !== (state.turn.ordinal === 1)) {
    context.addIssue({ code: "custom", message: "the first turn must have no predecessor and later turns must have one", path: ["turn"] });
  }
  const expectedLastEvent = {
    queued: "run.created",
    running: ["run.started", "run.approval_decided", "model.output.completed", "model.reasoning.completed", "context.compaction.completed"],
    awaiting_approval: "run.approval_requested",
    completed: "run.completed",
    failed: "run.failed",
    cancelled: "run.cancelled",
    blocked: "run.blocked",
  }[state.status.kind];
  const lastEventType = state.timeline.at(-1)?.type;
  if (Array.isArray(expectedLastEvent) ? !expectedLastEvent.includes(String(lastEventType)) : lastEventType !== expectedLastEvent) {
    context.addIssue({ code: "custom", message: "status does not match the last timeline event", path: ["timeline"] });
  }
  const eventIds = new Set<string>();
  for (const [index, event] of state.timeline.entries()) {
    if (eventIds.has(event.eventId)) context.addIssue({ code: "custom", message: "event identity is duplicated", path: ["timeline", index, "eventId"] });
    eventIds.add(event.eventId);
  }
  const toolInvocationIds = new Set<string>();
  for (const [index, call] of state.toolCalls.entries()) {
    const invocationId = toolInvocationId(call);
    if (toolInvocationIds.has(invocationId)) context.addIssue({ code: "custom", message: "tool invocation identity is duplicated", path: ["toolCalls", index, "invocationId"] });
    toolInvocationIds.add(invocationId);
    const resultKey = `${invocationId}:${call.status}`;
    if (call.status !== "approval_required" && state.toolResultRecordedAt[resultKey] === undefined) {
      context.addIssue({ code: "custom", message: "resolved tool result occurrence time is missing", path: ["toolResultRecordedAt", resultKey] });
    }
  }
  try {
    assertOrdinaryToolFactGraph(state);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Ordinary nested tool fact graph is invalid",
      path: ["toolCalls"],
    });
  }
  if (state.status.kind === "awaiting_approval") {
    const approvalFacts = state.toolCalls.filter((result) => result.status === "approval_required");
    const statusRequests = new Map(state.status.confirmationRequests.map((request) => [request.confirmationId, request] as const));
    const factRequests = new Map(approvalFacts.flatMap((result) => result.confirmationRequest === undefined
      ? []
      : [[result.confirmationRequest.confirmationId, result.confirmationRequest] as const]));
    const decidedConfirmationIds = new Set(state.timeline.flatMap((event) =>
      event.type === "run.approval_decided" ? [event.decision.confirmationId] : []));
    if (statusRequests.size !== state.status.confirmationRequests.length || factRequests.size !== approvalFacts.length ||
        [...factRequests.keys()].some((confirmationId) =>
          !statusRequests.has(confirmationId) && !decidedConfirmationIds.has(confirmationId))) {
      context.addIssue({ code: "custom", message: "awaiting approval facts must be pending or have a durable decision", path: ["status", "confirmationRequests"] });
    }
    for (const [confirmationId, request] of statusRequests) {
      if (!sameConfirmationRequestShape(request, factRequests.get(confirmationId))) {
        context.addIssue({ code: "custom", message: "awaiting approval request differs from its tool fact", path: ["status", "confirmationRequests"] });
      }
    }
  }
});
// Schema output is structurally the persisted state; the assertion bridges the
// passthrough fields whose domain types declare more members than the schema.
const stateSchema = rawStateSchema.transform((state) => {
  const { capabilityResolution: _resolution, toolMetrics, ...facts } = state;
  return { ...facts, ...(state.birth.recordToolMetrics === true && toolMetrics !== undefined ? { toolMetrics } : {}) };
}) as unknown as z.ZodType<OrdinaryRunState>;
const documentSchema: z.ZodType<OrdinaryRunSnapshotDocument> = z.object({
  schemaVersion: z.literal(ORDINARY_RUN_SCHEMA_VERSION), revision: z.number().int().positive(), savedAt: z.string().min(1), state: stateSchema,
}).strict();
const storedSnapshotSchema = z.object({
  schemaVersion: z.literal(ORDINARY_RUN_SCHEMA_VERSION),
  revision: z.number().int().positive(), savedAt: z.string().min(1),
  birthFile: z.literal("birth.json"),
  state: z.record(z.string(), z.unknown()),
}).strict().superRefine((document, context) => {
  if (Object.hasOwn(document.state, "birth")) context.addIssue({ code: "custom", message: "mutable state cannot contain Run birth" });
});
const storedBirthSchema = z.object({
  schemaVersion: z.literal("ordinary-run-birth/v1"), runId: z.string().min(1),
  birth: z.record(z.string(), z.unknown()),
}).strict();

const summarySchema = z.object({
  runId: z.string().min(1), conversationId: z.string().min(1), userTurnId: z.string().min(1), assistantTurnId: z.string().min(1),
  status: z.enum(["queued", "running", "awaiting_approval", "completed", "failed", "cancelled", "blocked"]),
  createdAt: z.string().min(1), updatedAt: z.string().min(1),
}).strict();
const manifestSchema = z.object({ schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION), entries: z.array(summarySchema) }).strict();

export function createFileSystemOrdinaryRunRepository(rootDir: string): OrdinaryRunRepository {
  const runQueues = new Map<string, Promise<void>>();
  let manifestQueue = Promise.resolve();
  let manifestEntries: Map<string, OrdinaryRunSummary> | undefined;
  let manifestDirty = false;

  const enqueueRun = <T>(runId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = runQueues.get(runId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    runQueues.set(runId, tail);
    void tail.finally(() => {
      if (runQueues.get(runId) === tail) runQueues.delete(runId);
    });
    return result;
  };
  const enqueueManifest = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = manifestQueue.then(operation, operation);
    manifestQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  async function currentManifest(forceRepair = false): Promise<Map<string, OrdinaryRunSummary>> {
    if (!forceRepair && !manifestDirty && manifestEntries !== undefined) return manifestEntries;
    if (!forceRepair && !manifestDirty) {
      const stored = await readManifest(rootDir);
      if (stored !== undefined) {
        manifestEntries = new Map(stored.map((entry) => [entry.runId, entry]));
        return manifestEntries;
      }
    }
    const rebuilt = new Map((await scanSummaries(rootDir)).map((entry) => [entry.runId, entry]));
    manifestEntries = rebuilt;
    manifestDirty = false;
    try {
      await writeManifest(rootDir, sortedSummaries(rebuilt.values()));
    } catch {
      // The snapshot remains the commit. Keep a usable in-process index and retry
      // reconciliation on the next access instead of failing an already committed run.
      manifestDirty = true;
    }
    return rebuilt;
  }

  async function updateManifest(
    update: (entries: Map<string, OrdinaryRunSummary>) => void,
  ): Promise<void> {
    await enqueueManifest(async () => {
      const current = await currentManifest();
      const next = new Map(current);
      update(next);
      try {
        await writeManifest(rootDir, sortedSummaries(next.values()));
      } catch (error) {
        manifestDirty = true;
        throw error;
      }
      manifestEntries = next;
      manifestDirty = false;
    });
  }

  return {
    save(state, expectedRevision) {
      return enqueueRun(state.runId, async () => {
        const current = await readSnapshot(rootDir, state.runId);
        const actualRevision = current?.revision ?? 0;
        if (actualRevision !== expectedRevision) {
          const cause = new Error(
            `Ordinary run ${state.runId} revision conflict: expected ${expectedRevision}, received ${actualRevision}`,
          );
          throw new OrdinaryFeatureError("ordinary_revision_conflict", cause.message, { cause });
        }
        const validation = documentSchema.safeParse({
          schemaVersion: ORDINARY_RUN_SCHEMA_VERSION,
          revision: actualRevision + 1,
          savedAt: state.timestamps.updatedAt,
          state: toPersistedJsonShape(state),
        });
        if (!validation.success) throw new OrdinaryRunSnapshotIncompatibleError(state.runId, z.prettifyError(validation.error));
        const document = validation.data;
        if (current !== undefined && !isDeepStrictEqual(current.state.birth, document.state.birth)) {
          throw new OrdinaryFeatureError("ordinary_run_state_conflict", "Run birth is immutable after creation");
        }
        if (current === undefined) await writeRunBirth(rootDir, document);
        await writeMutableRunSnapshot(rootDir, document);
        // The snapshot is the commit. Index maintenance is deliberately separate
        // from run writes so unrelated runs never wait for a full snapshot scan.
        await updateManifest((entries) => entries.set(state.runId, summaryFromDocument(document))).catch(() => undefined);
        return document;
      });
    },
    get(runId) { return readSnapshot(rootDir, runId); },
    async list(limit = 50) {
      const normalizedLimit = Math.max(0, Math.floor(limit));
      // Recovery owns full inventory repair. Query limits never trigger a filesystem scan.
      const summaries = await enqueueManifest(async () => {
        const entries = await currentManifest();
        return sortedSummaries(entries.values());
      });
      return toPersistedJsonShape(summaries.slice(0, normalizedLimit));
    },
    async inspectRecoveryInventory() {
      const inventory = await scanRecoveryInventory(rootDir);
      await enqueueManifest(async () => {
        manifestEntries = new Map(inventory.summaries.map((entry) => [entry.runId, entry]));
        manifestDirty = false;
        try { await writeManifest(rootDir, sortedSummaries(manifestEntries.values())); }
        catch { manifestDirty = true; }
      });
      return inventory;
    },
    delete(runId) {
      return enqueueRun(runId, async () => {
        await fs.rm(runDirectory(rootDir, runId), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
        await updateManifest((entries) => entries.delete(runId)).catch(() => undefined);
      });
    },
  };
}

async function readSnapshot(rootDir: string, runId: string): Promise<OrdinaryRunSnapshotDocument | undefined> {
  const stored = await readStoredJson(snapshotPath(rootDir, runId), runId);
  if (stored === undefined) return undefined;
  const snapshot = storedSnapshotSchema.safeParse(stored.raw);
  if (!snapshot.success) throw new OrdinaryRunSnapshotIncompatibleError(runId,
    "Run storage requires immutable birth.json plus mutable snapshot.json; explicitly run compact:run-storage before opening previous development snapshots");
  const birthStored = await readStoredJson(birthPath(rootDir, runId), runId);
  const parsedBirth = storedBirthSchema.safeParse(birthStored?.raw);
  if (!parsedBirth.success || parsedBirth.data.runId !== runId) {
    throw new OrdinaryRunSnapshotIncompatibleError(runId, "Run birth is missing or invalid");
  }
  const { model, capabilitySnapshot, ...facts } = parsedBirth.data.birth;
  if (typeof capabilitySnapshot !== "object" || capabilitySnapshot === null || Array.isArray(capabilitySnapshot)) {
    throw new OrdinaryRunSnapshotIncompatibleError(runId, "Run capability contract is invalid");
  }
  const birth = { ...facts, config: model, capabilitySnapshot: { ...capabilitySnapshot, activeModel: model } };
  const { birthFile: _birthFile, ...header } = snapshot.data;
  const result = documentSchema.safeParse({ ...header, state: { ...snapshot.data.state, birth } });
  if (!result.success || result.data.state.runId !== runId) {
    throw new OrdinaryRunSnapshotIncompatibleError(runId, result.success ? "run identity is invalid" : z.prettifyError(result.error));
  }
  return result.data;
}

function birthPath(rootDir: string, runId: string) { return path.join(runDirectory(rootDir, runId), "birth.json"); }

function storedRunBirth(document: OrdinaryRunSnapshotDocument) {
  const { config, capabilitySnapshot, ...facts } = document.state.birth;
  const { activeModel, ...capabilities } = capabilitySnapshot;
  if (!isDeepStrictEqual(config, activeModel)) throw new OrdinaryRunSnapshotIncompatibleError(document.state.runId, "Run model configuration differs from its capability contract");
  return { schemaVersion: "ordinary-run-birth/v1" as const, runId: document.state.runId,
    birth: { ...facts, model: config, capabilitySnapshot: capabilities } };
}

async function writeRunBirth(rootDir: string, document: OrdinaryRunSnapshotDocument) {
  await writeJsonAtomically(birthPath(rootDir, document.state.runId), storedRunBirth(document));
}

function storedMutableSnapshot(document: OrdinaryRunSnapshotDocument) {
  const { birth: _birth, capabilityResolution: _resolution, ...state } = document.state;
  return { ...document, birthFile: "birth.json" as const, state };
}

async function writeMutableRunSnapshot(rootDir: string, document: OrdinaryRunSnapshotDocument) {
  await writeJsonAtomically(snapshotPath(rootDir, document.state.runId), storedMutableSnapshot(document));
}

async function scanSummaries(rootDir: string): Promise<OrdinaryRunSummary[]> {
  return [...(await scanRecoveryInventory(rootDir)).summaries];
}

async function scanRecoveryInventory(rootDir: string): Promise<OrdinaryRunRecoveryInventory> {
  const directory = path.join(rootDir, "runs");
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  });
  const documents = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    let runId: string;
    try {
      runId = decodeURIComponent(entry.name);
    } catch (error) {
      return {
        runId: entry.name,
        error: new OrdinaryRunSnapshotIncompatibleError(entry.name, "run directory name is invalid"),
      } as const;
    }
    try {
      const document = await readSnapshot(rootDir, runId);
      return document === undefined
        ? { runId, error: new OrdinaryRunSnapshotIncompatibleError(runId, "snapshot is missing") } as const
        : { runId, document } as const;
    } catch (error) {
      return { runId, error } as const;
    }
  }));
  const summaries: OrdinaryRunSummary[] = [];
  const issues: OrdinaryRunRecoveryInventory["issues"][number][] = [];
  for (const document of documents) {
    if ("document" in document && document.document !== undefined) {
      summaries.push(summaryFromDocument(document.document));
    }
    else issues.push({ runId: document.runId, error: document.error });
  }
  return { summaries: sortedSummaries(summaries), issues };
}
async function writeManifest(rootDir: string, entries: readonly OrdinaryRunSummary[]): Promise<void> {
  const manifest = { schemaVersion: MANIFEST_SCHEMA_VERSION, entries };
  const result = manifestSchema.safeParse(manifest);
  if (!result.success) throw new OrdinaryRunSnapshotIncompatibleError("manifest", z.prettifyError(result.error));
  await writeJsonAtomically(manifestPath(rootDir), manifest);
}

async function readManifest(rootDir: string): Promise<readonly OrdinaryRunSummary[] | undefined> {
  try {
    const raw = await readJson(manifestPath(rootDir), "manifest");
    if (raw === undefined) return undefined;
    const parsed = manifestSchema.safeParse(raw);
    return parsed.success ? parsed.data.entries : undefined;
  } catch (error) {
    if (
      error instanceof OrdinaryRunSnapshotIncompatibleError ||
      isNodeError(error, "EISDIR") ||
      isNodeError(error, "ENOTDIR")
    ) return undefined;
    throw error;
  }
}

function sortedSummaries(entries: Iterable<OrdinaryRunSummary>): OrdinaryRunSummary[] {
  return [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function summaryFromDocument(document: OrdinaryRunSnapshotDocument): OrdinaryRunSummary {
  return {
    runId: document.state.runId,
    conversationId: document.state.turn.conversationId,
    userTurnId: document.state.turn.userTurnId,
    assistantTurnId: document.state.turn.assistantTurnId,
    status: document.state.status.kind,
    createdAt: document.state.timestamps.createdAt,
    updatedAt: document.state.timestamps.updatedAt,
  };
}

async function readJson(filePath: string, runId: string): Promise<unknown | undefined> {
  return (await readStoredJson(filePath, runId))?.raw;
}

async function readStoredJson(filePath: string, runId: string): Promise<{ readonly raw: unknown } | undefined> {
  const content = await fs.readFile(filePath, "utf8").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (content === undefined) return undefined;
  try { return { raw: JSON.parse(content) as unknown }; }
  catch { throw new OrdinaryRunSnapshotIncompatibleError(runId, "stored JSON is invalid"); }
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const tempDirectory = path.join(directory, ".tmp");
  const tempPath = path.join(tempDirectory, `${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.mkdir(tempDirectory, { recursive: true });
  await fs.writeFile(tempPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  try { await renameWithRetry(tempPath, filePath); }
  catch (error) { await fs.rm(tempPath, { force: true }).catch(() => undefined); throw error; }
}

function snapshotPath(rootDir: string, runId: string): string { return path.join(runDirectory(rootDir, runId), "snapshot.json"); }
function runDirectory(rootDir: string, runId: string): string { return path.join(rootDir, "runs", encodeURIComponent(runId)); }
function manifestPath(rootDir: string): string { return path.join(rootDir, "manifest.json"); }

function sameConfirmationRequestShape(
  left: ConfirmationRequest | undefined,
  right: ConfirmationRequest | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return left.confirmationId === right.confirmationId
    && left.invocationId === right.invocationId
    && left.title === right.title
    && left.actionSummary === right.actionSummary
    && left.consequence === right.consequence
    && left.riskLevel === right.riskLevel
    && left.requestedAt === right.requestedAt
    && left.expiresAt === right.expiresAt
    && left.resumeAvailability === right.resumeAvailability
    && sameStringList(left.affectedResources, right.affectedResources)
    && sameStringList(left.sourceRefs, right.sourceRefs)
    && left.conversationId === right.conversationId;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Offline maintenance validates all targets and preserves originals before converting previous development snapshots. */
export async function compactOrdinaryRunStorage(rootDir: string, backupRoot: string): Promise<{
  readonly count: number; readonly bytesBefore: number; readonly bytesAfter: number;
}> {
  const entries = await fs.readdir(path.join(rootDir, "runs"), { withFileTypes: true });
  const pending = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const runId = decodeURIComponent(entry.name);
    const original = await fs.readFile(snapshotPath(rootDir, runId), "utf8");
    const originalBirth = await fs.readFile(birthPath(rootDir, runId), "utf8").catch((error) => {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    });
    const raw = JSON.parse(original) as unknown;
    const document = storedSnapshotSchema.safeParse(raw).success
      ? await readSnapshot(rootDir, runId)
      : documentSchema.parse(raw);
    if (document === undefined || document.state.runId !== runId) throw new OrdinaryRunSnapshotIncompatibleError(runId, "run identity is invalid");
    const mutable = `${JSON.stringify(storedMutableSnapshot(document))}\n`;
    const birth = `${JSON.stringify(storedRunBirth(document))}\n`;
    return { runId, original, originalBirth, document, mutable, birth };
  }));
  let count = 0, bytesBefore = 0, bytesAfter = 0;
  for (const item of pending) {
    bytesBefore += Buffer.byteLength(item.original) + Buffer.byteLength(item.originalBirth ?? "");
    bytesAfter += Buffer.byteLength(item.mutable) + Buffer.byteLength(item.birth);
    if (item.original === item.mutable && item.originalBirth === item.birth) continue;
    const backupDir = path.join(backupRoot, encodeURIComponent(item.runId));
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, "snapshot.json"), item.original, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (item.originalBirth !== undefined) await fs.writeFile(path.join(backupDir, "birth.json"), item.originalBirth, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await writeRunBirth(rootDir, item.document);
    await writeMutableRunSnapshot(rootDir, item.document);
    count += 1;
  }
  return { count, bytesBefore, bytesAfter };
}
