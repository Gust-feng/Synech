import { getEncoding, type Tiktoken } from "js-tiktoken";

let encoding: Tiktoken | undefined;

/** Shared deterministic token accounting for memory editing, maintenance and history. */
export function countMemoryTokens(text: string): number {
  encoding ??= getEncoding("o200k_base");
  return encoding.encode(text).length;
}
