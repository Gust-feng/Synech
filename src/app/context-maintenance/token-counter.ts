import { encodingForModel, getEncoding, type Tiktoken } from "js-tiktoken";
import type { ModelInputAttachment, ModelMessage } from "../../domain/intelligence/index.js";
import type { AgentLoopTokenCounter } from "./contracts.js";

const DEFAULT_MODEL = "gpt-4o";

export function createOpenAITokenCounter(model = DEFAULT_MODEL): AgentLoopTokenCounter {
  const resolved = encodingForOpenAIModel(model);
  const encoding = resolved.encoding;
  return {
    source: "openai_tiktoken",
    model,
    tokenizerMatch: resolved.tokenizerMatch,
    countText(text) {
      return encoding.encode(text).length;
    },
    countMessage(message) {
      return messageTokenCount(encoding, message);
    },
    countMessages(messages) {
      return messages.reduce((total, message) => total + messageTokenCount(encoding, message), 0);
    },
  };
}

function encodingForOpenAIModel(model: string): {
  readonly encoding: Tiktoken;
  readonly tokenizerMatch: "model" | "fallback";
} {
  try {
    return { encoding: encodingForModel(model as never), tokenizerMatch: "model" };
  } catch {
    return { encoding: getEncoding("o200k_base"), tokenizerMatch: "fallback" };
  }
}

function messageTokenCount(encoding: Tiktoken, message: ModelMessage): number {
  const serialized = JSON.stringify({
    role: message.role,
    content: message.content,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    toolCalls: message.toolCalls,
    protocolExtensions: message.protocolExtensions,
    attachments: message.attachments?.map(attachmentMetadata),
  });
  return encoding.encode(serialized).length +
    (message.attachments ?? []).reduce((total, attachment) => total + attachmentTokenReserve(attachment), 0);
}

function attachmentMetadata(attachment: ModelInputAttachment): Readonly<Record<string, unknown>> {
  return {
    kind: attachment.kind,
    attachmentId: attachment.attachmentId,
    inputRef: attachment.inputRef,
    filename: attachment.filename,
    detail: attachment.kind === "audio" ? undefined : attachment.detail,
    byteLength: attachment.byteLength,
    sourceKind: attachment.source.kind,
    sourceRef: attachment.source.kind === "file_id"
      ? attachment.source.fileId
      : attachment.source.kind === "url"
        ? attachment.source.url
        : undefined,
  };
}

function attachmentTokenReserve(attachment: ModelInputAttachment): number {
  // Binary inputs are billed as model input but cannot be reconstructed by a
  // text tokenizer. Reserve a conservative amount from the metadata available
  // locally; the provider remains the final authority for exact image/file use.
  if (attachment.kind === "image") {
    if (attachment.detail === "low") {
      return 3_000;
    }
    return attachment.byteLength === undefined
      ? 8_000
      : Math.max(3_000, Math.min(32_000, Math.ceil(attachment.byteLength / 4)));
  }
  if (attachment.byteLength !== undefined) {
    return Math.max(1, Math.ceil(attachment.byteLength / 4));
  }
  return 2_000;
}
