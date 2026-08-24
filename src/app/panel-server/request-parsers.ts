import type {
  ConfiguredModelProtocolKind,
  ConfiguredModelProviderKind,
  CreateModelProviderProfileInput,
  McpConfirmationMode,
  McpServerTransportKind,
  ModelCapabilities,
  ModelRunReasoningEffort,
  ModelProviderModelCatalogItem,
  OpenAIModelRequestSettings,
  ToolStateSettings,
  UpdateInformationAccessConfigInput,
  UpdateCommandShellConfigInput,
  UpdateOrdinaryAgentPromptConfigInput,
  UpdateModelProviderConfigInput,
  UpdateSkillTriggerConfigInput,
  UpdateToolConfirmationConfigInput,
  UpdateWebSearchConfigInput,
  UpsertMcpServerInput,
} from "../../domain/config/index.js";
import { normalizeModelCatalogDisplayName } from "../../domain/config/index.js";
import type { ConfirmationDecision } from "../../domain/confirmation/index.js";
import type { ToolConfirmationPolicy } from "../../domain/tools/index.js";
import {
  OrdinaryRunContextInputValidationError,
  parseOrdinaryRunContextInput,
} from "../context/ordinary-run-input-adapter.js";
import type { CreateContextAttachmentPreviewInput } from "./workbench/context-attachment-preview.js";
import type { ModelRuntimeMode } from "../model-runtime/index.js";
import type { OrdinaryRunContextInput } from "../../domain/ordinary/index.js";
import { ORDINARY_AGENT_SYSTEM_PROMPT_MAX_CHARS, isKnownOrdinaryAgentPromptVariant } from "../config-center/ordinary-agent-prompt-settings.js";
import { sanitizeAssistantVisibleText } from "../text-projection/visible-text-safety.js";
import { preserveVisibleText } from "../../kernel/visible-text-policy.js";
import { z } from "zod";
import { PanelHttpError } from "./http-utils.js";

export type PanelRunInput = {
  readonly goal: string;
  readonly submissionId?: string;
  /** Canonical owner for a new Conversation. */
  readonly owner?: { readonly kind: "space" | "workspace"; readonly id: string };
  readonly aiMode?: ModelRuntimeMode;
  readonly reasoningEffort?: ModelRunReasoningEffort;
  readonly toolConfirmationPolicy?: ToolConfirmationPolicy;
  readonly modelOverride?: {
    readonly profileId: string;
    readonly model: string;
  };
  /** Canonical request field for one Ordinary turn. */
  readonly contextInput?: OrdinaryRunContextInput;
};

export type ConversationRenameInput = {
  readonly title: string;
};

export type ConversationPinInput = {
  readonly pinned: boolean;
};

export type ModelCatalogUpdateInput = {
  readonly label?: string;
  readonly baseUrl?: string;
  readonly modelsPath?: string;
  readonly fetchedAt?: string;
  readonly models: readonly ModelProviderModelCatalogItem[];
};

export type ModelProviderOrderUpdateInput = {
  readonly order: readonly string[];
};

export type ModelCapabilityUpdateInput = {
  readonly profileId?: string;
  readonly model?: string;
  readonly providerKind?: ConfiguredModelProviderKind;
  readonly capabilities: Partial<ModelCapabilities>;
};

type ConversationRollbackInput = {
  readonly targetTurnId?: string;
  readonly targetRunId?: string;
  readonly stepsBack?: number;
};

type ContextAttachmentPreviewRequestInput = CreateContextAttachmentPreviewInput;

export type McpEnvironmentRequestInput = {
  readonly commandLine?: string;
  readonly command?: string;
};

const optionalTrimmedStringSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined,
  z.string().optional(),
);
const optionalBooleanSchema = z.preprocess(
  (value) => typeof value === "boolean" ? value : undefined,
  z.boolean().optional(),
);
const optionalFiniteNumberSchema = z.preprocess(
  (value) => typeof value === "number" && Number.isFinite(value) ? value : undefined,
  z.number().optional(),
);
const normalizeRequestObject = (value: unknown): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
const requestRecordSchema = z.preprocess(normalizeRequestObject, z.record(z.string(), z.unknown()));
const modelProviderKindSchema = z.enum(["openai_compatible"]);
const modelProtocolKindSchema = z.enum(["openai_responses", "openai_compatible_chat_completions"]);
const preferredApiStyleSchema = z.enum(["chat_completions", "responses", "openai_compatible"]);
const modelStabilitySchema = z.enum(["stable", "preview", "deprecated", "unknown"]);
const mcpTransportSchema = z.enum(["stdio", "http"]);
const mcpConfirmationModeSchema = z.enum(["always", "unsafe_only", "never"]);
const mcpToolExposureModeSchema = z.enum(["none", "all", "selected"]);
const webSearchProviderSchema = z.enum(["tavily", "exa", "zai", "metaso", "google", "bing", "model_builtin", "none"]);
const toolConfirmationPolicySchema = z.enum(["prompt", "full_access"]);
const skillTriggerModeSchema = z.enum(["keyword", "model"]);
const aiModeSchema = z.enum(["none", "openai-compatible", "openai-responses"]);
const configuredAiModeSchema = z.enum(["none", "openai-compatible", "openai-responses"]);

const conversationOwnerSchema = z.object({
  kind: z.enum(["space", "workspace"]),
  id: optionalTrimmedStringSchema,
}).strict().superRefine((owner, context) => {
  if (owner.id === undefined) {
    context.addIssue({ code: "custom", path: ["id"], message: "owner id is required" });
  }
});

const ordinaryRunRequestSchema = z.preprocess(normalizeRequestObject, z.object({
  goal: optionalTrimmedStringSchema,
  submissionId: optionalTrimmedStringSchema,
  owner: conversationOwnerSchema.optional(),
  aiMode: z.unknown().optional(),
  reasoningEffort: z.unknown().optional(),
  toolConfirmationPolicy: z.unknown().optional(),
  modelOverride: z.unknown().optional(),
  contextInput: z.unknown().optional(),
}));

const conversationRollbackRequestSchema = z.preprocess(normalizeRequestObject, z.object({
  targetTurnId: optionalTrimmedStringSchema,
  targetRunId: optionalTrimmedStringSchema,
  stepsBack: optionalFiniteNumberSchema,
}));

const contextAttachmentPreviewRequestSchema = z.preprocess(normalizeRequestObject, z.object({
  kind: z.unknown().optional(),
  value: optionalTrimmedStringSchema,
  ref: optionalTrimmedStringSchema,
  title: optionalTrimmedStringSchema,
  summary: optionalTrimmedStringSchema,
}));
const conversationRenameRequestSchema = z.preprocess(normalizeRequestObject, z.object({
  title: optionalTrimmedStringSchema,
}));
const conversationPinRequestSchema = z.preprocess(normalizeRequestObject, z.object({
  pinned: z.unknown().optional(),
}));
const confirmationDecisionRequestSchema = z.preprocess(normalizeRequestObject, z.object({
  decision: z.unknown().optional(),
  guidance: optionalTrimmedStringSchema,
}));
const skillStateRequestSchema = z.preprocess(normalizeRequestObject, z.object({
  enabled: z.unknown().optional(),
  stateKey: optionalTrimmedStringSchema,
}));
const mcpEnvironmentRequestSchema = z.preprocess(normalizeRequestObject, z.object({
  commandLine: optionalTrimmedStringSchema,
  command: optionalTrimmedStringSchema,
}));

// Keep request parsing stateless. Route modules decide what to do with validated inputs.
export function parseConfigUpdate(raw: unknown): UpdateModelProviderConfigInput {
  const record = parseRequestRecord(raw);
  const update: UpdateModelProviderConfigInput = {
    profileId: optionalString(record.profileId),
    label: optionalString(record.label),
    logoDataUrl: optionalString(record.logoDataUrl),
    clearLogoDataUrl: booleanOrUndefined(record.clearLogoDataUrl),
    providerKind: parseOptionalModelProviderKind(record.providerKind),
    protocolKind: parseOptionalModelProtocolKind(record.protocolKind),
    baseUrl: optionalString(record.baseUrl),
    model: optionalString(record.model),
    clearModel: booleanOrUndefined(record.clearModel),
    defaultAiMode: parseOptionalConfiguredAiMode(record.defaultAiMode, "默认 AI 模式无效。"),
    enabled: booleanOrUndefined(record.enabled),
    apiKey: optionalString(record.apiKey),
    clearApiKey: booleanOrUndefined(record.clearApiKey),
  };
  return "openAI" in record
    ? {
        ...update,
        openAI: parseOpenAIModelRequestSettings(record.openAI),
      }
    : update;
}

export function parseCreateModelProfile(raw: unknown): CreateModelProviderProfileInput {
  const parsed = parseConfigUpdate(raw);
  const profileId = optionalString(parseRequestRecord(raw).profileId);
  if (profileId === undefined) {
    throw new PanelHttpError(400, "missing_model_profile_id", "模型 profile id 不能为空。");
  }
  return {
    ...parsed,
    profileId,
  };
}

export function parseModelProviderOrderUpdate(raw: unknown): ModelProviderOrderUpdateInput {
  const record = parseRequestRecord(raw);
  if (!Array.isArray(record.order)) {
    throw new PanelHttpError(400, "invalid_model_provider_order", "模型服务顺序必须是数组。");
  }
  const order = record.order
    .map((value) => optionalString(value))
    .filter((value): value is string => value !== undefined);
  return { order };
}

export function parseModelCatalogUpdate(raw: unknown): ModelCatalogUpdateInput {
  const record = parseRequestRecord(raw);
  const modelsRaw = record.models;
  if (!Array.isArray(modelsRaw)) {
    throw new PanelHttpError(400, "invalid_model_catalog", "模型列表必须是数组。");
  }
  const models = modelsRaw
    .map((item): ModelProviderModelCatalogItem | undefined => {
      const model = parseRequestRecord(item);
      const id = optionalString(model.id);
      if (id === undefined) {
        return undefined;
      }
      return {
        id,
        displayName: normalizeModelCatalogDisplayName(optionalString(model.displayName), id),
        owner: optionalString(model.owner),
        createdAt: optionalString(model.createdAt),
      };
    })
    .filter((item): item is ModelProviderModelCatalogItem => item !== undefined);
  return {
    label: optionalString(record.label),
    baseUrl: optionalString(record.baseUrl),
    modelsPath: optionalString(record.modelsPath),
    fetchedAt: optionalString(record.fetchedAt),
    models,
  };
}

export function parseModelCapabilityUpdate(raw: unknown): ModelCapabilityUpdateInput {
  const record = parseRequestRecord(raw);
  const capabilities = parseRequestRecord(record.capabilities ?? raw);
  return {
    profileId: optionalString(record.profileId),
    model: optionalString(record.model),
    providerKind: parseOptionalModelProviderKind(record.providerKind),
    capabilities: {
      contextWindowTokens: positiveIntegerOrUndefined(capabilities.contextWindowTokens, "上下文窗口 token 必须是正整数。"),
      maxOutputTokens: positiveIntegerOrUndefined(capabilities.maxOutputTokens, "最大输出 token 必须是正整数。"),
      supportsToolCalling: booleanOrUndefined(capabilities.supportsToolCalling),
      supportsParallelToolCalls: booleanOrUndefined(capabilities.supportsParallelToolCalls),
      supportsStructuredOutputs: booleanOrUndefined(capabilities.supportsStructuredOutputs),
      supportsStreaming: booleanOrUndefined(capabilities.supportsStreaming),
      supportsVisionInput: booleanOrUndefined(capabilities.supportsVisionInput),
      supportsReasoningEffort: booleanOrUndefined(capabilities.supportsReasoningEffort),
      supportsReasoningOutput: booleanOrUndefined(capabilities.supportsReasoningOutput),
      preferredApiStyle: parseOptionalPreferredApiStyle(capabilities.preferredApiStyle),
      stability: parseOptionalModelStability(capabilities.stability),
      lastVerifiedAt: optionalString(capabilities.lastVerifiedAt),
    },
  };
}

function positiveIntegerOrUndefined(value: unknown, message: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new PanelHttpError(400, "invalid_model_capability", message);
  }
  return Math.floor(value);
}

function parseOptionalPreferredApiStyle(value: unknown): ModelCapabilities["preferredApiStyle"] | undefined {
  return parseOptionalEnum(preferredApiStyleSchema, value, "invalid_model_capability", "模型 API 风格无效。");
}

function parseOptionalModelStability(value: unknown): ModelCapabilities["stability"] | undefined {
  return parseOptionalEnum(modelStabilitySchema, value, "invalid_model_capability", "模型稳定性无效。");
}

export function parseToolStateUpdate(toolName: string, raw: unknown): ToolStateSettings {
  const request = z.preprocess(normalizeRequestObject, z.object({ enabled: z.unknown().optional() })).parse(raw);
  const enabled = z.boolean().safeParse(request.enabled);
  if (!enabled.success) {
    throw new PanelHttpError(400, "invalid_tool_state", "工具状态必须包含 enabled 布尔值。");
  }
  return {
    name: toolName,
    enabled: enabled.data,
    updatedAt: new Date().toISOString(),
  };
}

export function parseToolConfirmationUpdate(raw: unknown): UpdateToolConfirmationConfigInput {
  const request = z.preprocess(normalizeRequestObject, z.object({ policy: z.unknown().optional() })).parse(raw);
  const policy = parseToolConfirmationPolicy(request.policy);
  if (policy === undefined) {
    throw new PanelHttpError(400, "invalid_tool_confirmation_policy", "工具确认策略无效。");
  }
  return { policy };
}

export function parseOrdinaryAgentPromptUpdate(raw: unknown): UpdateOrdinaryAgentPromptConfigInput {
  const request = z.preprocess(normalizeRequestObject, z.object({
    resetSystemPrompt: optionalBooleanSchema,
    systemPrompt: z.unknown().optional(),
    systemPromptVariant: z.unknown().optional(),
  })).parse(raw);
  if (request.resetSystemPrompt === true) {
    return { resetSystemPrompt: true };
  }
  if (isKnownOrdinaryAgentPromptVariant(request.systemPromptVariant)) {
    return { systemPromptVariant: request.systemPromptVariant };
  }
  if (request.systemPromptVariant !== undefined) {
    throw new PanelHttpError(400, "invalid_ordinary_agent_prompt_variant", "提示词偏好无效。");
  }
  if (typeof request.systemPrompt !== "string") {
    throw new PanelHttpError(400, "missing_ordinary_agent_prompt", "系统提示词不能为空。");
  }
  const systemPrompt = request.systemPrompt.trim();
  if (systemPrompt.length === 0) {
    throw new PanelHttpError(400, "missing_ordinary_agent_prompt", "系统提示词不能为空。");
  }
  if (systemPrompt.length > ORDINARY_AGENT_SYSTEM_PROMPT_MAX_CHARS) {
    throw new PanelHttpError(400, "ordinary_agent_prompt_too_large", "系统提示词过长。");
  }
  return { systemPrompt };
}

export function parseSkillTriggerUpdate(raw: unknown): UpdateSkillTriggerConfigInput {
  const request = z.preprocess(normalizeRequestObject, z.object({ mode: z.unknown().optional() })).parse(raw);
  const mode = parseSkillTriggerMode(request.mode);
  if (mode === undefined) {
    throw new PanelHttpError(400, "invalid_skill_trigger_mode", "Skills 触发方式无效。");
  }
  return { mode };
}

export function parseMcpServerUpdate(raw: unknown): UpsertMcpServerInput {
  const record = parseRequestRecord(raw);
  const serverId = optionalString(record.serverId);
  if (serverId === undefined) {
    throw new PanelHttpError(400, "missing_mcp_server_id", "MCP server id 不能为空。");
  }
  return {
    serverId,
    label: optionalString(record.label),
    description: typeof record.description === "string" ? record.description : undefined,
    transport: parseOptionalMcpTransport(record.transport),
    commandLine: optionalString(record.commandLine),
    command: optionalString(record.command),
    args: stringArrayOrUndefined(record.args),
    url: optionalString(record.url),
    envSecretRefs: stringArrayOrUndefined(record.envSecretRefs),
    headerSecretRefs: stringArrayOrUndefined(record.headerSecretRefs),
    bearerTokenSecretRef: optionalString(record.bearerTokenSecretRef),
    apiKeySecretRef: optionalString(record.apiKeySecretRef),
    apiKeyHeaderName: optionalString(record.apiKeyHeaderName),
    clearMcpAuth: booleanOrUndefined(record.clearMcpAuth),
    confirmationMode: parseOptionalMcpConfirmationMode(record.confirmationMode),
    toolExposureMode: parseOptionalMcpToolExposureMode(record.toolExposureMode),
    enabledTools: stringArrayOrUndefined(record.enabledTools),
    autoApprovedTools: stringArrayOrUndefined(record.autoApprovedTools),
    enabled: booleanOrUndefined(record.enabled),
  };
}

export function parseMcpServerSecretValue(raw: unknown): {
  readonly secretRef: string;
  readonly value: string;
} {
  const record = parseRequestRecord(raw);
  const secretRef = optionalString(record.secretRef);
  const value = optionalString(record.value);
  if (secretRef === undefined) {
    throw new PanelHttpError(400, "missing_mcp_secret_ref", "MCP secret ref 不能为空。");
  }
  if (value === undefined) {
    throw new PanelHttpError(400, "missing_mcp_secret_value", "MCP secret value 不能为空。");
  }
  return { secretRef, value };
}

export function parseMcpEnvironmentRequest(raw: unknown): McpEnvironmentRequestInput {
  return mcpEnvironmentRequestSchema.parse(raw);
}

export function parseMcpServerImport(raw: unknown): readonly UpsertMcpServerInput[] {
  const record = parseRequestRecord(raw);
  const source = typeof record.config === "string" ? parseJsonObject(record.config) : record.config ?? raw;
  const sourceRecord = parseRequestRecord(source);
  const serversRaw = sourceRecord.mcpServers;
  if (serversRaw === undefined) {
    throw new PanelHttpError(400, "missing_mcp_import_servers", "导入内容未找到 mcpServers。");
  }
  if (Array.isArray(serversRaw)) {
    throw new PanelHttpError(400, "invalid_mcp_import_servers", "mcpServers 必须是按 server id 索引的对象。");
  }
  const entries = Object.entries(parseRequestRecord(serversRaw));
  const imported = entries
    .map(([serverId, value]) => importedMcpServer(serverId, value))
    .filter((server): server is UpsertMcpServerInput => server !== undefined);
  if (imported.length === 0) {
    throw new PanelHttpError(400, "empty_mcp_import", "没有可导入的 MCP server。");
  }
  return imported;
}

export function parseCommandShellUpdate(raw: unknown): UpdateCommandShellConfigInput {
  const record = parseRequestRecord(raw);
  const kind = optionalString(record.kind);
  if (kind === undefined) {
    throw new PanelHttpError(400, "missing_command_shell_kind", "命令 shell 不能为空。");
  }
  if (
    kind !== "auto" &&
    kind !== "cmd" &&
    kind !== "powershell" &&
    kind !== "pwsh" &&
    kind !== "bash" &&
    kind !== "sh"
  ) {
    throw new PanelHttpError(400, "invalid_command_shell_kind", "命令 shell 无效。");
  }
  return {
    kind,
    executable: optionalString(record.executable),
  };
}

export function parseInformationAccessUpdate(raw: unknown): UpdateInformationAccessConfigInput {
  const record = parseRequestRecord(raw);
  return {
    provider: parseOptionalWebSearchProvider(record.provider),
    apiKey: optionalString(record.apiKey),
    maxResults: numberOrUndefined(record.maxResults),
    engineId: optionalString(record.engineId),
  };
}

export function parseWebSearchUpdate(raw: unknown): UpdateWebSearchConfigInput {
  const record = parseRequestRecord(raw);
  return {
    provider: parseOptionalWebSearchProvider(record.provider),
    apiKey: optionalString(record.apiKey),
    maxResults: numberOrUndefined(record.maxResults),
    engineId: optionalString(record.engineId),
  };
}

export function parseRunInput(raw: unknown): PanelRunInput {
  const request = ordinaryRunRequestSchema.parse(raw);
  const goal = request.goal;
  if (goal === undefined) {
    throw new PanelHttpError(400, "missing_goal", "运行需要填写目标。");
  }
  if (request.submissionId !== undefined && request.submissionId.length > 200) {
    throw new PanelHttpError(400, "invalid_submission_id", "提交标识无效。");
  }
  const owner = request.owner === undefined
    ? undefined
    : { kind: request.owner.kind, id: request.owner.id! };
  return {
    goal,
    submissionId: request.submissionId,
    owner,
    aiMode: parseOptionalAiMode(request.aiMode, "AI 模式无效。"),
    reasoningEffort: parseOptionalRunReasoningEffort(request.reasoningEffort),
    toolConfirmationPolicy: parseToolConfirmationPolicy(request.toolConfirmationPolicy),
    modelOverride: parseModelOverride(request.modelOverride),
    contextInput: parseOrdinaryRunContextInputFromRequest(request.contextInput),
  };
}

export function parseConversationRenameInput(raw: unknown): ConversationRenameInput {
  const title = conversationRenameRequestSchema.parse(raw).title;
  if (title === undefined) {
    throw new PanelHttpError(400, "missing_conversation_title", "会话标题不能为空。");
  }
  return { title };
}

export function parseConversationPinInput(raw: unknown): ConversationPinInput {
  const pinned = z.boolean().safeParse(conversationPinRequestSchema.parse(raw).pinned);
  if (!pinned.success) {
    throw new PanelHttpError(400, "invalid_conversation_pin_state", "置顶状态必须是布尔值。");
  }
  return { pinned: pinned.data };
}

export function parseConfirmationDecision(raw: unknown): Pick<ConfirmationDecision, "decision" | "guidance"> {
  const request = confirmationDecisionRequestSchema.parse(raw);
  const decision = z.enum(["approve_once", "deny", "guidance"]).safeParse(request.decision);
  if (!decision.success) {
    throw new PanelHttpError(400, "invalid_confirmation_decision", "确认操作无效。");
  }
  const guidance = request.guidance;
  if (decision.data === "guidance" && guidance === undefined) {
    throw new PanelHttpError(400, "missing_confirmation_guidance", "补充要求不能为空。");
  }
  return {
    decision: decision.data,
    guidance: guidance === undefined ? undefined : compactDecisionGuidance(guidance),
  };
}

export function parseSkillStateRequest(raw: unknown): { readonly enabled: boolean; readonly stateKey?: string } {
  const request = skillStateRequestSchema.parse(raw);
  const enabled = z.boolean().safeParse(request.enabled);
  if (!enabled.success) {
    throw new PanelHttpError(400, "invalid_skill_state", "技能状态必须包含 enabled 布尔值。");
  }
  return { enabled: enabled.data, stateKey: request.stateKey };
}

export function parseConversationRollbackInput(raw: unknown): ConversationRollbackInput {
  return conversationRollbackRequestSchema.parse(raw);
}

export function parseContextAttachmentPreviewRequest(raw: unknown): ContextAttachmentPreviewRequestInput {
  const request = contextAttachmentPreviewRequestSchema.parse(raw);
  const kind = z.enum(["workspace", "file", "project", "web"]).safeParse(request.kind);
  if (request.kind !== undefined && request.kind !== null && request.kind !== "" && !kind.success) {
    throw new PanelHttpError(400, "invalid_context_attachment_kind", "上下文附件类型必须是 workspace、file、project 或 web。");
  }
  return {
    kind: kind.success ? kind.data : undefined,
    value: request.value,
    ref: request.ref,
    title: request.title,
    summary: request.summary,
  };
}

export function parseOrdinaryRunContextInputFromRequest(raw: unknown): OrdinaryRunContextInput {
  try {
    return parseOrdinaryRunContextInput(raw);
  } catch (error) {
    if (error instanceof OrdinaryRunContextInputValidationError) {
      throw new PanelHttpError(400, error.code, error.message);
    }
    throw error;
  }
}

export function parseOptionalOrdinaryRunContextInput(raw: unknown): OrdinaryRunContextInput | undefined {
  return raw === undefined ? undefined : parseOrdinaryRunContextInputFromRequest(raw);
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new PanelHttpError(499, "run_cancelled", "运行已取消。");
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseRequestRecord(value: unknown): Record<string, unknown> {
  return requestRecordSchema.parse(value);
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function parseOptionalModelProviderKind(value: unknown): ConfiguredModelProviderKind | undefined {
  return parseOptionalEnum(modelProviderKindSchema, value, "invalid_model_provider_kind", "模型厂商类型无效。");
}

function parseOptionalModelProtocolKind(value: unknown): ConfiguredModelProtocolKind | undefined {
  return parseOptionalEnum(modelProtocolKindSchema, value, "invalid_model_protocol_kind", "模型协议类型无效。");
}

function parseOptionalMcpTransport(value: unknown): McpServerTransportKind | undefined {
  return parseOptionalEnum(mcpTransportSchema, value, "invalid_mcp_transport", "MCP transport 必须是 stdio 或 streamableHttp。");
}

function parseOptionalMcpConfirmationMode(value: unknown): McpConfirmationMode | undefined {
  return parseOptionalEnum(mcpConfirmationModeSchema, value, "invalid_mcp_confirmation_mode", "MCP 确认模式无效。");
}

function parseOptionalMcpToolExposureMode(value: unknown): UpsertMcpServerInput["toolExposureMode"] {
  return parseOptionalEnum(mcpToolExposureModeSchema, value, "invalid_mcp_tool_exposure_mode", "MCP 工具暴露模式无效。");
}

function parseOptionalWebSearchProvider(value: unknown): UpdateWebSearchConfigInput["provider"] {
  return parseOptionalEnum(webSearchProviderSchema, value, "invalid_web_search_provider", "搜索工具 provider 无效。");
}

function parseToolConfirmationPolicy(value: unknown): ToolConfirmationPolicy | undefined {
  return parseOptionalEnum(toolConfirmationPolicySchema, value, "invalid_tool_confirmation_policy", "工具确认策略无效。");
}

function parseSkillTriggerMode(value: unknown): UpdateSkillTriggerConfigInput["mode"] | undefined {
  return parseOptionalEnum(skillTriggerModeSchema, value, "invalid_skill_trigger_mode", "Skills 触发方式无效。");
}

function parseModelOverride(value: unknown): PanelRunInput["modelOverride"] {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = parseRequestRecord(value);
  const profileId = optionalString(record.profileId);
  const model = optionalString(record.model);
  if (profileId === undefined || model === undefined) {
    throw new PanelHttpError(400, "invalid_model_override", "本次运行的模型选择无效。");
  }
  return { profileId, model };
}

export function parseOptionalAiMode(value: unknown, invalidMessage: string): ModelRuntimeMode | undefined {
  return parseOptionalEnum(aiModeSchema, value, "invalid_ai_mode", invalidMessage);
}

function parseOptionalConfiguredAiMode(
  value: unknown,
  invalidMessage: string,
): import("../../domain/config/index.js").ConfiguredModelRuntimeMode | undefined {
  return parseOptionalEnum(configuredAiModeSchema, value, "invalid_ai_mode", invalidMessage);
}

function parseOptionalEnum<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: string,
  message: string,
): T | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PanelHttpError(400, code, message);
  return parsed.data;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayOrUndefined(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => optionalString(item))
    .filter((item): item is string => item !== undefined);
  return items.length === 0 ? undefined : items;
}

function importedMcpServer(serverId: string, raw: unknown): UpsertMcpServerInput | undefined {
  const record = parseRequestRecord(raw);
  const id = optionalString(record.serverId) ?? optionalString(record.name) ?? serverId;
  const transport = parseImportedMcpTransport(record.transport ?? record.type, record.url);
  const command = optionalString(record.command);
  const args = stringArrayOrUndefined(record.args);
  const url = optionalString(record.url);
  const envRefs = Object.entries(parseRequestRecord(record.env))
    .map(([key, value]) => secretRefFromEnvValue(key, value))
    .filter((value): value is string => value !== undefined);
  const headerRefs = Object.entries(parseRequestRecord(record.headers))
    .map(([key, value]) => secretRefFromHeaderValue(id, key, value))
    .filter((value): value is string => value !== undefined);
  return {
    serverId: id,
    label: optionalString(record.label) ?? id,
    description: optionalString(record.description),
    transport,
    command,
    args,
    url,
    envSecretRefs: envRefs,
    headerSecretRefs: headerRefs,
    confirmationMode: "never",
    toolExposureMode: "none",
    enabled: booleanOrUndefined(record.enabled) ?? false,
  };
}

function parseImportedMcpTransport(value: unknown, url: unknown): UpsertMcpServerInput["transport"] {
  if (value === "http" || value === "streamableHttp" || value === "sse" || optionalString(url) !== undefined) return "http";
  return "stdio";
}

function secretRefFromEnvValue(key: string, value: unknown): string | undefined {
  if (optionalString(key) === undefined) return undefined;
  if (typeof value === "string" && value.startsWith("secret://")) return value;
  return key;
}

function secretRefFromHeaderValue(serverId: string, key: string, value: unknown): string | undefined {
  const headerName = optionalString(key);
  if (headerName === undefined) return undefined;
  const ref = typeof value === "string" && value.startsWith("secret://")
    ? value
    : `secret://local-dev/mcp/${serverId}/${headerName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
  return `${headerName}=${ref}`;
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new PanelHttpError(400, "invalid_mcp_import_json", "导入内容不是有效 JSON。");
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseOpenAIModelRequestSettings(value: unknown): OpenAIModelRequestSettings {
  if (value === undefined || value === null) {
    return {};
  }
  const record = parseRequestRecord(value);
  return {
    temperature: optionalNumberInRange(record.temperature, 0, 2, "temperature 必须在 0 到 2 之间。"),
    topP: optionalNumberInRange(record.topP, 0, 1, "top_p 必须在 0 到 1 之间。"),
    maxOutputTokens: optionalPositiveInteger(record.maxOutputTokens, "最大输出 token 必须是正整数。"),
    reasoningEffort: parseOptionalOpenAIReasoningEffort(record.reasoningEffort),
    reasoningSummary: parseOptionalOpenAIReasoningSummary(record.reasoningSummary),
    textVerbosity: parseOptionalOpenAITextVerbosity(record.textVerbosity),
    serviceTier: parseOptionalOpenAIServiceTier(record.serviceTier),
    truncation: parseOptionalOpenAITruncation(record.truncation),
    stream: booleanOrUndefined(record.stream),
    parallelToolCalls: booleanOrUndefined(record.parallelToolCalls),
    store: booleanOrUndefined(record.store),
  };
}

function optionalNumberInRange(value: unknown, min: number, max: number, message: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new PanelHttpError(400, "invalid_openai_parameter", message);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, message: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new PanelHttpError(400, "invalid_openai_parameter", message);
  }
  return Math.floor(value);
}

function parseOptionalOpenAIReasoningEffort(value: unknown): OpenAIModelRequestSettings["reasoningEffort"] {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  throw new PanelHttpError(400, "invalid_openai_parameter", "reasoning effort 无效。");
}

function parseOptionalRunReasoningEffort(value: unknown): ModelRunReasoningEffort | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new PanelHttpError(400, "invalid_openai_parameter", "思考强度只能是 low、medium 或 high。");
}

function parseOptionalOpenAIReasoningSummary(value: unknown): OpenAIModelRequestSettings["reasoningSummary"] {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "auto" || value === "concise" || value === "detailed") return value;
  throw new PanelHttpError(400, "invalid_openai_parameter", "reasoning summary 无效。");
}

function parseOptionalOpenAITextVerbosity(value: unknown): OpenAIModelRequestSettings["textVerbosity"] {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new PanelHttpError(400, "invalid_openai_parameter", "text verbosity 无效。");
}

function parseOptionalOpenAIServiceTier(value: unknown): OpenAIModelRequestSettings["serviceTier"] {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "auto" || value === "default" || value === "flex" || value === "priority") return value;
  throw new PanelHttpError(400, "invalid_openai_parameter", "service tier 无效。");
}

function parseOptionalOpenAITruncation(value: unknown): OpenAIModelRequestSettings["truncation"] {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "auto" || value === "disabled") return value;
  throw new PanelHttpError(400, "invalid_openai_parameter", "truncation 无效。");
}

function compactDecisionGuidance(value: string): string {
  const maxLength = 800;
  const normalized = preserveVisibleText(sanitizeAssistantVisibleText(value))
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}
