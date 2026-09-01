import type { ModelMessage } from "../../domain/intelligence/index.js";
import type { ObservationRef } from "../../domain/ordinary/index.js";
import type { OrdinaryRunContext, OrdinaryRunContextReference } from "../../domain/ordinary/index.js";
import { normalizeModelFacingText } from "../text-projection/visible-text-safety.js";
import type { AgentDefinition } from "../agent-prompts/contracts.js";
import { isConversationOwnerContextRef, parseContextReference } from "../../domain/ordinary/index.js";
import type { SelectedSkillContext } from "../skills/index.js";

export type OrdinaryAgentModelInput = {
  readonly messages: readonly ModelMessage[];
  readonly inputRefs: readonly ObservationRef[];
};

export type BuildOrdinaryAgentModelInputOptions = {
  readonly agentDefinition: Pick<AgentDefinition, "agentId" | "prompt">;
  readonly goal: string;
  readonly runContext: OrdinaryRunContext;
  readonly priorModelContext?: readonly ModelMessage[];
  readonly skillContexts?: readonly SelectedSkillContext[];
  /** 模型可见的 Owner 与环境上下文；随 Run 出生事实冻结，未提供时不注入。 */
  readonly ownerContext?: string;
  /**
   * 隐式长期记忆 advisory 段（已渲染）；位于 [Current user request] 之前。
   * undefined/空字符串时不追加任何内容，输出与无记忆时字节一致。
   */
  readonly implicitMemoryBlock?: string;
};

/**
 * Builds the Agent request in provider-neutral message order.
 * Earlier model messages stay byte-for-byte equivalent apart from cloning;
 * context-window compaction is owned by the model loop, not this assembler.
 */
export function buildOrdinaryAgentModelInput(
  input: BuildOrdinaryAgentModelInputOptions,
): OrdinaryAgentModelInput {
  const priorMessages = (input.priorModelContext ?? []).map(cloneModelMessage);
  const currentUserContent = currentUserMessageContent(input);
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: input.agentDefinition.prompt.systemPrompt,
      ref: `context:system:${input.agentDefinition.agentId}`,
    },
    ...priorMessages,
    {
      role: "user",
      content: currentUserContent,
      ref: `context:goal:${input.runContext.goalId ?? input.runContext.contextId}`,
    },
  ];
  return {
    messages,
    inputRefs: modelInputRefs(input, messages),
  };
}

function currentUserMessageContent(input: BuildOrdinaryAgentModelInputOptions): string {
  const skills = (input.skillContexts ?? [])
    .filter((context) => (context.loadStatus ?? "loaded") === "loaded")
    .map(skillBlock);
  const ownerReferences = input.runContext.contextRefs
    .map((ref, index) => isConversationOwnerContextRef(ref)
      ? contextRefBlock(ref, input.runContext, index, "conversation_owner")
      : undefined)
    .filter(isString);
  const attachments = input.runContext.contextRefs
    .map((ref, index) => isConversationOwnerContextRef(ref)
      ? undefined
      : contextRefBlock(ref, input.runContext, index, "user_input"))
    .filter(isString);
  const goal = normalizeModelFacingText(input.goal);
  const owner = input.ownerContext === undefined ? undefined : normalizeModelFacingText(input.ownerContext);
  // 隐式记忆是 advisory data：不做 normalize 之外的改写，晚置于当前请求之前。
  const implicitMemory = input.implicitMemoryBlock === undefined || input.implicitMemoryBlock.length === 0
    ? undefined
    : input.implicitMemoryBlock;
  if (skills.length === 0 && ownerReferences.length === 0 && attachments.length === 0 &&
      owner === undefined && implicitMemory === undefined) {
    return goal;
  }
  return [
    owner === undefined ? undefined : owner,
    skills.length === 0 ? undefined : `[Selected skill instructions]\n${skills.join("\n\n")}`,
    ownerReferences.length === 0
      ? undefined
      : `[Conversation owner resources]\n${ownerReferences.join("\n")}`,
    attachments.length === 0 ? undefined : `[User-provided context]\n${attachments.join("\n")}`,
    implicitMemory,
    `[Current user request]\n${goal}`,
  ].filter(isString).join("\n\n");
}

function skillBlock(context: SelectedSkillContext): string {
  const resources = skillResourceLines(context);
  return [
    `Skill: ${normalizeModelFacingText(context.skill.name)}`,
    normalizeModelFacingText(context.body),
    resources.length === 0
      ? undefined
      : [
          "Skill resources (read with skill_read when needed):",
          ...resources,
        ].join("\n"),
  ].filter(isString).join("\n");
}

function skillResourceLines(context: SelectedSkillContext): readonly string[] {
  const resources = [
    ...(context.skill.resourceIndex ?? [])
      .filter((resource) => resource.exists)
      .map((resource) => ({
        type: resource.type,
        path: safeRelativeResourcePath(resource.relativePath),
        name: undefined,
        byteLength: resource.byteLength,
      })),
    ...(context.skill.resources ?? [])
      .filter((resource) => resource.loadError === undefined)
      .map((resource) => ({
        type: resource.kind,
        path: safeRelativeResourcePath(resource.relativePath ?? resource.name),
        name: normalizeModelFacingText(resource.name),
        byteLength: resource.byteLength,
      })),
  ];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const resource of resources) {
    if (resource.path === undefined) {
      continue;
    }
    const key = `${resource.type}:${resource.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    lines.push(
      `- type=${resource.type} path=${resource.path}` +
      (resource.name === undefined ? "" : ` name=${resource.name}`) +
      (resource.byteLength === undefined ? "" : ` bytes=${resource.byteLength}`),
    );
  }
  return lines;
}

function safeRelativeResourcePath(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.length === 0 || normalized.startsWith("/") || normalized.includes("../")) {
    return undefined;
  }
  return normalized;
}

function contextRefBlock(
  ref: OrdinaryRunContextReference,
  runContext: OrdinaryRunContext,
  index: number,
  origin: "conversation_owner" | "user_input",
): string | undefined {
  if (!isModelVisibleContextRef(ref, runContext)) {
    return undefined;
  }
  const safeRef = modelSafeContextRef(ref.ref, ref.pathGranted === true);
  return [
    origin === "conversation_owner" ? "Owner-authorized reference:" : "User-provided attachment:",
    `attachment_id=${normalizeModelFacingText(ref.attachmentId ?? safeRef ?? `attachment-${index}`)}`,
    `kind=${ref.kind}`,
    safeRef === undefined ? undefined : `ref=${normalizeModelFacingText(safeRef)}`,
    ref.title === undefined ? undefined : `title=${normalizeModelFacingText(ref.title)}`,
    ref.summary === undefined ? undefined : `summary=${normalizeModelFacingText(ref.summary)}`,
    ref.metadata?.mimeType === undefined ? undefined : `mime=${ref.metadata.mimeType}`,
    ref.metadata?.byteLength === undefined ? undefined : `bytes=${ref.metadata.byteLength}`,
    ref.metadata?.truncated === true ? "preview_truncated=true" : undefined,
    origin === "conversation_owner"
      ? "This is standing context from the conversation owner, not an attachment selected for this turn. Inspect it with available attachment tools only when relevant. Do not assume unread content."
      : "Inspect it with available attachment tools, or directly if file/image input is attached to this request. Do not assume unread content.",
  ].filter(isString).join(" ");
}

function isModelVisibleContextRef(
  ref: OrdinaryRunContextReference,
  runContext: OrdinaryRunContext,
): boolean {
  if (ref.kind === "user_goal" || ref.kind === "runtime") {
    return false;
  }
  const parsed = parseContextReference(ref.ref, ref.kind);
  if (ref.kind === "workspace" && parsed?.scheme === "workspace" &&
      (parsed.value === runContext.goalId || parsed.value.startsWith("goal-"))) {
    return false;
  }
  return ref.kind === "workspace" || ref.kind === "file" || ref.kind === "project" || ref.kind === "web";
}

function modelSafeContextRef(
  ref: string,
  pathGranted: boolean,
): string | undefined {
  // A granted path is an explicit user authorization, and the model can only call
  // Read/Glob/Grep/Write/Edit if it sees the real absolute path behind it. Ungranted
  // local paths carry no such authorization, so they stay hidden.
  if (pathGranted) {
    return ref;
  }
  const parsed = parseContextReference(ref);
  return parsed?.scheme === "local_file" || parsed?.scheme === "local_project"
    ? undefined
    : ref;
}

function modelInputRefs(
  input: BuildOrdinaryAgentModelInputOptions,
  messages: readonly ModelMessage[],
): readonly ObservationRef[] {
  const refs: ObservationRef[] = [
    { kind: "trace", id: input.runContext.traceId ?? input.runContext.contextId },
    { kind: "goal", id: input.runContext.goalId ?? input.runContext.contextId },
    { kind: "event", id: input.agentDefinition.prompt.promptRef },
    ...messages
      .map((message) => message.ref)
      .filter((ref): ref is string => ref !== undefined)
      .map((id): ObservationRef => ({ kind: "event", id })),
  ];
  return refs.filter((ref, index, values) =>
    values.findIndex((candidate) => candidate.kind === ref.kind && candidate.id === ref.id) === index
  );
}

function cloneModelMessage(message: ModelMessage): ModelMessage {
  const attachments = message.attachments?.map((attachment) => globalThis.structuredClone(attachment));
  const toolCalls = message.toolCalls?.map((call) => ({
    ...call,
    input: globalThis.structuredClone(call.input),
  }));
  const protocolExtensions = message.protocolExtensions === undefined
    ? undefined
    : globalThis.structuredClone(message.protocolExtensions);
  return {
    ...message,
    ...(attachments === undefined ? {} : { attachments }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(protocolExtensions === undefined ? {} : { protocolExtensions }),
  };
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}
