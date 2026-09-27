import type { ModelMessage } from "../../domain/intelligence/index.js";

export type AgentLoopTokenCounter = {
  readonly source: "openai_tiktoken";
  readonly model: string;
  /** Whether js-tiktoken recognized this exact model instead of using a generic encoding fallback. */
  readonly tokenizerMatch?: "model" | "fallback";
  countText(text: string): number;
  countMessage(message: ModelMessage): number;
  countMessages(messages: readonly ModelMessage[]): number;
};
