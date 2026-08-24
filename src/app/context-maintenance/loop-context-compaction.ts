import type { ModelCapabilities } from "../../domain/config/index.js";
import type { ModelMessage, ModelOutputContract } from "../../domain/intelligence/index.js";
import type { ToolDefinition } from "../../domain/tools/index.js";
import { createId, nowIso } from "../../kernel/id.js";
import { normalizeModelFacingText } from "../text-projection/visible-text-safety.js";
import type {
  AgentLoopContextMaintenanceResult,
  AgentLoopContextSummary,
  AgentLoopTokenCounter,
  MaintainAgentLoopContextInput,
} from "./contracts.js";

const DEFAULT_THRESHOLD_RATIO = 0.8;
const DEFAULT_PRESERVE_RECENT_TOKEN_BUDGET = 40_000;
const MAX_COMPACTION_OUTPUT_TOKENS = 2_000;

/**
 * Compacts model/tool loop messages without deciding any feature outcome. The
 * calling feature remains responsible for completion, failure, and retry semantics.
 */
export async function compactAgentLoopContextIfNeeded(
  input: MaintainAgentLoopContextInput
): Promise<AgentLoopContextMaintenanceResult> {
  const tokenCounter = input.tokenCounter;
  const tokenCount = loopContextTokenCount(tokenCounter, input.messages, input.tools);
  const threshold = loopContextThreshold(input.modelCapabilities, input.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO);
  if (tokenCount < threshold) {
    return { status: "unchanged", tokenCount, threshold };
  }

  const split = splitLoopMessagesForCompaction(
    input.messages,
    input.tokenCounter,
    input.preserveRecentTokenBudget ?? defaultPreserveRecentTokenBudget(input.modelCapabilities),
    input.preserveLatestToolInteraction === true,
  );
  if (split.compactible.length === 0) {
    return {
      status: "failed",
      tokenCount,
      threshold,
      message: "Context exceeds its compaction threshold, but only required messages remain.",
    };
  }

  const requestId = createId("model-request");
  const response = await input.intelligenceChannel.request({
    requestId,
    traceId: input.traceId,
    callerRef: { kind: "goal", id: input.goalId, label: "context_compaction" },
    purpose: "context_compaction",
    inputRefs: split.compactible.map((entry) => ({
      kind: "event" as const,
      id: entry.message.ref ?? `loop-context:${entry.index}`,
    })),
    sanitizedMessages: loopCompactionMessages({
      goal: input.goal,
      agentDisplayName: compactionAgentDisplayName(input.agentIdentity),
      compactible: split.compactible,
    }),
    outputContract: contextCompactionOutputContract(),
    budget: {
      maxOutputTokens: Math.min(
        input.modelCapabilities?.maxOutputTokens ?? MAX_COMPACTION_OUTPUT_TOKENS,
        MAX_COMPACTION_OUTPUT_TOKENS
      ),
    },
    sensitivity: "internal",
    requestedAt: nowIso(),
    toolChoice: "none",
    tools: [],
  }, { abortSignal: input.abortSignal });

  if (response.status !== "completed") {
    return {
      status: "failed",
      tokenCount,
      threshold,
      message: response.failure?.message ?? "Context compaction model call failed.",
      requestId,
      responseId: response.responseId,
      usage: response.usage,
    };
  }

  const promptText = normalizeModelFacingText(
    typeof response.textOutput === "string" && response.textOutput.trim().length > 0
      ? response.textOutput
      : typeof response.structuredOutput === "string"
        ? response.structuredOutput
        : ""
  ).trim();
  if (promptText.length === 0) {
    return {
      status: "failed",
      tokenCount,
      threshold,
      message: "Context compaction returned an empty continuation prompt.",
      requestId,
      responseId: response.responseId,
      usage: response.usage,
    };
  }

  const summary: AgentLoopContextSummary = {
    summaryId: createId("conversation-summary"),
    summary: promptText,
    coveredRefs: split.compactible.map((entry) => entry.message.ref ?? `loop-context:${entry.index}`),
    modelRequestId: requestId,
    modelResponseId: response.responseId,
  };
  const compactedMessages = assembleCompactedLoopMessages(
    input.messages,
    split.preservedIndexes,
    summary,
    input.compactedContextRole ?? "system",
  );
  const compactedTokenCount = loopContextTokenCount(tokenCounter, compactedMessages, input.tools);
  if (compactedTokenCount >= input.modelCapabilities.contextWindowTokens) {
    return {
      status: "failed",
      tokenCount,
      threshold,
      message: `Context compaction did not reduce the request below the model window (${compactedTokenCount}/${input.modelCapabilities.contextWindowTokens} tokens).`,
      requestId,
      responseId: response.responseId,
      usage: response.usage,
    };
  }

  return {
    status: "compacted",
    tokenCount,
    threshold,
    conversationSummary: summary,
    messages: compactedMessages,
    usage: response.usage,
  };
}

function loopCompactionMessages(input: {
  readonly goal: string;
  readonly agentDisplayName: string;
  readonly compactible: readonly {
    readonly message: ModelMessage;
    readonly index: number;
  }[];
}): readonly ModelMessage[] {
  return [
    {
      role: "system",
      content: [
        `You compact earlier runtime context for ${input.agentDisplayName}, the agent for this run.`,
        "Return exactly one Markdown continuation prompt. Do not return JSON.",
        "Preserve still-relevant goals, user constraints, progress, decisions, next actions, errors, evidence refs, and file paths.",
        "Preserve concrete tool results, errors, stdout/stderr, file content fragments, and development context that may be needed to continue.",
        "Do not decide whether the task is complete. Do not instruct the agent to stop.",
        "",
        "Use this section order:",
        "## Goal",
        "## Constraints & Preferences",
        "## Progress",
        "### Done",
        "### In Progress",
        "### Blocked",
        "## Key Decisions",
        "## Next Steps",
        "## Critical Context",
        "## Relevant Files",
      ].join("\n"),
      ref: "prompt:context.compaction.v1",
    },
    {
      role: "user",
      content: [
        `Current user request: ${normalizeModelFacingText(input.goal)}`,
        "Context to compact:",
        ...input.compactible.map((entry) => serializeLoopMessageForCompaction(entry.message, entry.index)),
        "",
        "Write the continuation prompt so the main agent can continue the same task from the preserved recent messages.",
      ].join("\n"),
      ref: "context:loop-compaction:input",
    },
  ];
}

function splitLoopMessagesForCompaction(
  messages: readonly ModelMessage[],
  tokenCounter: AgentLoopTokenCounter,
  preserveRecentTokenBudget: number,
  preserveLatestToolInteraction: boolean,
): {
  readonly compactible: readonly { readonly message: ModelMessage; readonly index: number }[];
  readonly preservedIndexes: ReadonlySet<number>;
} {
  const preserved = new Set<number>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "system") {
      break;
    }
    preserved.add(index);
  }
  const currentUserIndex = findCurrentUserMessageIndex(messages);
  if (currentUserIndex !== undefined) {
    preserved.add(currentUserIndex);
  }
  if (preserveLatestToolInteraction) {
    preserveLatestCompleteToolInteraction(messages, preserved);
  }
  preserveRecentInteractionTail(
    messages,
    tokenCounter,
    preserveRecentTokenBudget,
    preserved,
  );
  preserveOnlyCompleteToolInteractionGroups(messages, preserved);
  const compactible = messages
    .map((message, index) => ({ message, index }))
    .filter((entry) => !preserved.has(entry.index));
  return { compactible, preservedIndexes: preserved };
}

type MessageGroup = {
  readonly indexes: readonly number[];
  readonly tokenCount: number;
};

function preserveRecentInteractionTail(
  messages: readonly ModelMessage[],
  tokenCounter: AgentLoopTokenCounter,
  tokenBudget: number,
  preserved: Set<number>,
): void {
  const requiredTokenCount = tokenCountForIndexes(
    messages,
    [...preserved].filter((index) => messages[index]?.role !== "system"),
    tokenCounter,
  );
  let remaining = Math.max(0, Math.floor(tokenBudget) - requiredTokenCount);
  for (const group of messageGroupsFromEnd(messages, tokenCounter)) {
    if (group.indexes.some((index) => preserved.has(index))) continue;
    if (group.tokenCount > remaining) break;
    group.indexes.forEach((index) => preserved.add(index));
    remaining -= group.tokenCount;
  }
}

function messageGroupsFromEnd(
  messages: readonly ModelMessage[],
  tokenCounter: AgentLoopTokenCounter,
): readonly MessageGroup[] {
  const groups: MessageGroup[] = [];
  const groupedIndexes = new Set<number>();

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (groupedIndexes.has(index) || messages[index]?.role === "system") continue;
    const message = messages[index]!;
    if (message.role === "tool") {
      const assistantIndex = findToolCallAssistantIndex(messages, message.toolCallId);
      if (assistantIndex !== undefined && !groupedIndexes.has(assistantIndex)) {
        const callIds = new Set(messages[assistantIndex]?.toolCalls?.map((call) => call.callId));
        const indexes = [
          assistantIndex,
          ...messages
            .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
            .filter(({ candidate }) => candidate.role === "tool" && candidate.toolCallId !== undefined && callIds.has(candidate.toolCallId))
            .map(({ candidateIndex }) => candidateIndex),
        ].sort((left, right) => left - right);
        indexes.forEach((groupIndex) => groupedIndexes.add(groupIndex));
        groups.push({ indexes, tokenCount: tokenCountForIndexes(messages, indexes, tokenCounter) });
        continue;
      }
    }
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      const callIds = new Set(message.toolCalls?.map((call) => call.callId));
      const indexes = [
        index,
        ...messages
          .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
          .filter(({ candidate }) => candidate.role === "tool" && candidate.toolCallId !== undefined && callIds.has(candidate.toolCallId))
          .map(({ candidateIndex }) => candidateIndex),
      ].sort((left, right) => left - right);
      indexes.forEach((groupIndex) => groupedIndexes.add(groupIndex));
      groups.push({ indexes, tokenCount: tokenCountForIndexes(messages, indexes, tokenCounter) });
      continue;
    }
    groupedIndexes.add(index);
    groups.push({ indexes: [index], tokenCount: tokenCounter.countMessage(message) });
  }
  return groups;
}

function findToolCallAssistantIndex(
  messages: readonly ModelMessage[],
  toolCallId: string | undefined,
): number | undefined {
  if (toolCallId === undefined) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant" && messages[index]?.toolCalls?.some((call) => call.callId === toolCallId)) {
      return index;
    }
  }
  return undefined;
}

function tokenCountForIndexes(
  messages: readonly ModelMessage[],
  indexes: readonly number[],
  tokenCounter: AgentLoopTokenCounter,
): number {
  return indexes.reduce((total, index) => total + tokenCounter.countMessage(messages[index]!), 0);
}

function preserveLatestCompleteToolInteraction(
  messages: readonly ModelMessage[],
  preserved: Set<number>,
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || (message.toolCalls?.length ?? 0) === 0) continue;
    const callIds = new Set(message.toolCalls?.map((call) => call.callId));
    const resultIndexes = messages
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidate }) => candidate.role === "tool" && candidate.toolCallId !== undefined && callIds.has(candidate.toolCallId))
      .map(({ candidateIndex }) => candidateIndex);
    if (resultIndexes.length !== callIds.size) return;
    preserved.add(index);
    resultIndexes.forEach((resultIndex) => preserved.add(resultIndex));
    return;
  }
}

function findCurrentUserMessageIndex(messages: readonly ModelMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "user" &&
      (message.ref?.startsWith("context:goal:") === true || message.content.includes("Current user message:"))
    ) {
      return index;
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }
  return undefined;
}

function preserveOnlyCompleteToolInteractionGroups(
  messages: readonly ModelMessage[],
  preserved: Set<number>
): void {
  const toolResultIndexes = new Map<string, number[]>();
  messages.forEach((message, index) => {
    if (message.role === "tool" && message.toolCallId !== undefined) {
      toolResultIndexes.set(message.toolCallId, [...(toolResultIndexes.get(message.toolCallId) ?? []), index]);
    }
  });
  const groupedToolResultIndexes = new Set<number>();
  messages.forEach((message, index) => {
    const calls = message.toolCalls ?? [];
    if (message.role !== "assistant" || calls.length === 0) {
      return;
    }
    const group = new Set([
      index,
      ...calls.flatMap((call) => toolResultIndexes.get(call.callId) ?? []),
    ]);
    group.forEach((groupIndex) => {
      if (messages[groupIndex]?.role === "tool") {
        groupedToolResultIndexes.add(groupIndex);
      }
    });
    const complete = calls.every((call) => (toolResultIndexes.get(call.callId)?.length ?? 0) === 1);
    if (!complete) {
      group.forEach((groupIndex) => preserved.delete(groupIndex));
      return;
    }
    const preservedCount = [...group].filter((groupIndex) => preserved.has(groupIndex)).length;
    if (preservedCount === 0 || preservedCount === group.size) {
      return;
    }
    // A provider tool interaction is one protocol unit. If the recent window
    // cuts through it, compact the whole unit instead of emitting orphaned
    // function outputs or an assistant call with only some results.
    group.forEach((groupIndex) => preserved.delete(groupIndex));
  });
  messages.forEach((message, index) => {
    if (message.role === "tool" && preserved.has(index) && !groupedToolResultIndexes.has(index)) {
      preserved.delete(index);
    }
  });
}

function assembleCompactedLoopMessages(
  messages: readonly ModelMessage[],
  preservedIndexes: ReadonlySet<number>,
  summary: AgentLoopContextSummary,
  role: "system" | "user",
): readonly ModelMessage[] {
  const compactedMessage: ModelMessage = {
    role,
    content: [
      "# Compacted Context",
      "",
      summary.summary,
      "",
      "Continue the original task from this context. This summary is background only and is not a completion signal.",
    ].join("\n"),
    ref: summary.summaryId,
  };
  const output: ModelMessage[] = [];
  let inserted = false;
  messages.forEach((message, index) => {
    if (preservedIndexes.has(index)) {
      output.push(cloneLoopMessage(message));
      return;
    }
    if (!inserted) {
      output.push(compactedMessage);
      inserted = true;
    }
  });
  if (!inserted) {
    output.unshift(compactedMessage);
  }
  return output;
}

function serializeLoopMessageForCompaction(message: ModelMessage, index: number): string {
  const ref = message.ref ?? `loop-context:${index}`;
  const toolCalls = message.toolCalls?.length
    ? `\n  toolCalls: ${message.toolCalls.map((call) =>
        `${call.toolName}#${call.callId} input=${serializeToolInput(call.input)}`
      ).join(", ")}`
    : "";
  const toolResult = message.toolCallId === undefined
    ? ""
    : `\n  toolResultFor: ${message.toolName ?? "tool"}#${message.toolCallId}`;
  return [
    `- [${ref}] ${message.role}:${toolCalls}${toolResult}`,
    indentBlock(normalizeModelFacingText(message.content)),
  ].join("\n");
}

function loopContextTokenCount(
  counter: AgentLoopTokenCounter,
  messages: readonly ModelMessage[],
  tools: readonly ToolDefinition[]
): number {
  return counter.countMessages(messages) +
    counter.countText(serializeToolsForTokenBudget(tools));
}

function loopContextThreshold(capabilities: ModelCapabilities, ratio: number): number {
  const windowTokens = capabilities.contextWindowTokens;
  return Math.max(1, Math.floor(windowTokens * clampRatio(ratio)));
}

function defaultPreserveRecentTokenBudget(capabilities: ModelCapabilities): number {
  return Math.min(
    DEFAULT_PRESERVE_RECENT_TOKEN_BUDGET,
    Math.max(2, Math.floor(capabilities.contextWindowTokens * 0.15)),
  );
}

function serializeToolsForTokenBudget(tools: readonly ToolDefinition[]): string {
  if (tools.length === 0) {
    return "";
  }
  return JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })));
}

function cloneLoopMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    attachments: message.attachments?.map((attachment) => globalThis.structuredClone(attachment)),
    toolCalls: message.toolCalls?.map((toolCall) => ({
      callId: toolCall.callId,
      toolName: toolCall.toolName,
      input: globalThis.structuredClone(toolCall.input),
    })),
    protocolExtensions:
      message.protocolExtensions === undefined ? undefined : globalThis.structuredClone(message.protocolExtensions),
  };
}

function contextCompactionOutputContract(): ModelOutputContract {
  return {
    contractId: "context.compaction.v1",
    outputKind: "explanation",
    format: "text",
    minTextLength: 1,
    maxTextLength: 6000,
    visibleOutput: {
      fields: ["text"],
      maxFieldLength: 1200,
    },
  };
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_THRESHOLD_RATIO;
  }
  return Math.min(0.95, Math.max(0.1, value));
}

function compactionAgentDisplayName(input: { readonly displayName: string } | undefined): string {
  const displayName = input?.displayName.replace(/\s+/g, " ").trim();
  return displayName === undefined || displayName.length === 0 ? "Agent" : displayName;
}

function indentBlock(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

function serializeToolInput(value: unknown): string {
  try {
    return normalizeModelFacingText(JSON.stringify(value) ?? "null");
  } catch {
    return "[unserializable tool input]";
  }
}
