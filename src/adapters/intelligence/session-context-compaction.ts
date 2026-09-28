import {
  DEFAULT_COMPACTION_SETTINGS,
  compact,
  estimateContextTokens,
  estimateTokens,
  prepareCompaction,
  shouldCompact,
  type AgentMessage,
  type CompactionSettings,
  type Session,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { AgentSessionEntryRef } from "../../app/model-runtime/agent-session.js";
import { COMPACTION_IMAGE_PLACEHOLDER, replaceImageBlocks } from "./session-image-placeholder.js";

export type SessionContextCompactionResult =
  | { readonly status: "unchanged" }
  | {
      readonly status: "compacted";
      readonly compactedContextMessages: readonly AgentMessage[];
      readonly compactionEntryRef: AgentSessionEntryRef;
      readonly tokensBefore: number;
      /** Image blocks this compaction replaced with text placeholders before summarizing. */
      readonly replacedImageBlocks: number;
    }
  | {
      readonly status: "failed";
      readonly code: "context_compaction_failed" | "context_overflow";
      readonly error: string;
    };

export type SessionContextCompactionInput = {
  readonly agentSession: Session;
  readonly activeContextMessages: readonly AgentMessage[];
  readonly modelRegistry: Models;
  readonly selectedModel: Model<Api>;
  /**
   * 已确认的上下文窗口（真实 Pi Model.contextWindow）。未确认模型没有事实窗口，
   * 传 undefined：不得按 adapter 内部的 transport 常量猜测阈值触发压缩。
   */
  readonly confirmedContextWindowTokens?: number;
  /** Pi's frozen reasoning setting must also govern compaction summaries. */
  readonly thinkingLevel?: ThinkingLevel;
  readonly abortSignal: AbortSignal;
  readonly compactionSettings?: CompactionSettings;
  readonly compactionInstructions?: string;
};

/**
 * Compacts the active Session branch with Pi's public compaction primitives.
 * AgentHarness currently exposes compact() only while idle, so the request
 * boundary adapter cannot invoke that method during a live turn; this helper
 * deliberately delegates preparation, summarization, and append semantics to
 * Pi instead of maintaining a second compaction state machine.
 */
export async function compactSessionContextIfNeeded(
  input: SessionContextCompactionInput,
): Promise<SessionContextCompactionResult> {
  const compactionSettings = input.compactionSettings ?? DEFAULT_COMPACTION_SETTINGS;
  if (!compactionSettings.enabled) return { status: "unchanged" };
  const contextWindowTokens = input.confirmedContextWindowTokens;
  if (contextWindowTokens === undefined) {
    // 未确认窗口：不按猜测值触发压缩，交由真实上游在上下文超限时如实报告。
    return { status: "unchanged" };
  }
  const contextTokens = estimateContextTokens([...input.activeContextMessages]).tokens;
  if (!shouldCompact(contextTokens, contextWindowTokens, compactionSettings)) {
    return { status: "unchanged" };
  }
  const prepared = prepareCompaction(await input.agentSession.getBranch(), compactionSettings);
  if (!prepared.ok) {
    return { status: "failed", code: "context_compaction_failed", error: prepared.error.message };
  }
  if (prepared.value === undefined) {
    return {
      status: "failed",
      code: "context_overflow",
      error: "The active session context exceeds the model window but has no safe compaction cut point.",
    };
  }
  let replacedImageBlocks = 0;
  if (prepared.value.messagesToSummarize.some(containsImageContent) ||
      prepared.value.turnPrefixMessages.some(containsImageContent)) {
    // Pi has no image-aware compaction, so the summarizer would silently drop
    // image blocks. Vision-capable and text-only models alike degrade to an
    // observable text placeholder: the run keeps going and the replacement
    // count reports exactly what was lost.
    const summarized = replaceImageBlocks(prepared.value.messagesToSummarize, COMPACTION_IMAGE_PLACEHOLDER);
    const prefix = replaceImageBlocks(prepared.value.turnPrefixMessages, COMPACTION_IMAGE_PLACEHOLDER);
    replacedImageBlocks = summarized.replacedImageBlocks + prefix.replacedImageBlocks;
    prepared.value = {
      ...prepared.value,
      messagesToSummarize: [...summarized.messages],
      turnPrefixMessages: [...prefix.messages],
    };
  }
  const compacted = await compact(
    prepared.value,
    input.modelRegistry,
    input.selectedModel,
    input.compactionInstructions,
    input.abortSignal,
    input.thinkingLevel,
  );
  if (!compacted.ok) {
    return { status: "failed", code: "context_compaction_failed", error: compacted.error.message };
  }
  const compactionEntryId = await input.agentSession.appendCompaction(
    compacted.value.summary,
    compacted.value.firstKeptEntryId,
    compacted.value.tokensBefore,
    compacted.value.details,
  );
  const compactedContextMessages = (await input.agentSession.buildContext()).messages;
  // A retained assistant message still carries usage for its pre-compaction
  // request. That usage is no longer a valid size for the rebuilt context.
  const compactedContextTokens = compactedContextMessages.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
  if (shouldCompact(
    compactedContextTokens,
    contextWindowTokens,
    compactionSettings,
  )) {
    return {
      status: "failed",
      code: "context_overflow",
      error: "The active session context still exceeds the safe model window after compaction.",
    };
  }
  const sessionId = (await input.agentSession.getMetadata()).id;
  return {
    status: "compacted",
    compactedContextMessages,
    compactionEntryRef: { sessionId, entryId: compactionEntryId },
    tokensBefore: compacted.value.tokensBefore,
    replacedImageBlocks,
  };
}

function containsImageContent(message: AgentMessage): boolean {
  const content = (message as { readonly content?: unknown }).content;
  return Array.isArray(content) && content.some((block) =>
    typeof block === "object" && block !== null &&
    (block as { readonly type?: unknown }).type === "image",
  );
}