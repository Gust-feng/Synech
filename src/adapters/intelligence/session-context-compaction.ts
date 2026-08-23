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
import { replaceUnsupportedImageBlocks } from "./session-image-placeholder.js";

export type SessionContextCompactionResult =
  | { readonly status: "unchanged" }
  | {
      readonly status: "compacted";
      readonly compactedContextMessages: readonly AgentMessage[];
      readonly compactionEntryRef: AgentSessionEntryRef;
      readonly tokensBefore: number;
    }
  | {
      readonly status: "failed";
      readonly code: "context_compaction_failed" | "context_overflow" | "context_compaction_images_unsupported";
      readonly error: string;
    };

export type SessionContextCompactionInput = {
  readonly agentSession: Session;
  readonly activeContextMessages: readonly AgentMessage[];
  readonly modelRegistry: Models;
  readonly selectedModel: Model<Api>;
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
  const contextTokens = estimateContextTokens([...input.activeContextMessages]).tokens;
  if (!shouldCompact(contextTokens, input.selectedModel.contextWindow, compactionSettings)) {
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
  if (prepared.value.messagesToSummarize.some(containsImageContent) ||
      prepared.value.turnPrefixMessages.some(containsImageContent)) {
    // Pi has no image-aware compaction, so a summary cannot preserve image
    // content. A vision-capable model must fail rather than silently lose
    // the images; a text-only model substitutes an observable text notice so
    // the run keeps working without faking or summarizing the pixels.
    const modelInputSupportsImage = input.selectedModel.input.includes("image");
    if (modelInputSupportsImage) {
      return {
        status: "failed",
        code: "context_compaction_images_unsupported",
        error: "The active Session contains image content in the compaction prefix; Pi image-aware request-boundary compaction is required.",
      };
    }
    prepared.value = {
      ...prepared.value,
      messagesToSummarize: [...replaceUnsupportedImageBlocks(prepared.value.messagesToSummarize, modelInputSupportsImage)],
      turnPrefixMessages: [...replaceUnsupportedImageBlocks(prepared.value.turnPrefixMessages, modelInputSupportsImage)],
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
    input.selectedModel.contextWindow,
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
  };
}

function containsImageContent(message: AgentMessage): boolean {
  const content = (message as { readonly content?: unknown }).content;
  return Array.isArray(content) && content.some((block) =>
    typeof block === "object" && block !== null &&
    (block as { readonly type?: unknown }).type === "image",
  );
}