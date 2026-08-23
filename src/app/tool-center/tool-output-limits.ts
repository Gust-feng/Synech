export const DEFAULT_MAX_INLINE_TOOL_OUTPUT_CHARS = 180_000;
/** Fixed model-visible budgets; they deliberately do not scale with model context windows. */
export const DEFAULT_TARGET_INLINE_TOOL_BODY_TOKENS = 4_000;
export const DEFAULT_MAX_INLINE_TOOL_RESULT_TOKENS = 6_000;

export type ToolOutputTokenCounter = {
  countText(text: string): number;
};

// Producer-managed text windows need room for paths, headers, status, and
// continuation metadata before ToolCenter applies the full-result limit.
export const TOOL_OUTPUT_METADATA_RESERVE_CHARS = 4_096;
export const DEFAULT_MAX_INLINE_TOOL_CONTENT_JSON_CHARS =
  DEFAULT_MAX_INLINE_TOOL_OUTPUT_CHARS - TOOL_OUTPUT_METADATA_RESERVE_CHARS;

// A JSON string can expand one UTF-16 code unit to six characters (for
// example, U+0000 becomes "\u0000"). Reserve enough space for the reader's
// common metadata so the default window is useful. The reader also measures
// the actual serialized envelope and shrinks each page when provider ids or
// other provenance fields consume more of the inline budget.
export const TOOL_OUTPUT_READ_ENVELOPE_RESERVE_CHARS = 6_000;
export const MAX_TOOL_OUTPUT_READ_CHARS = Math.floor(
  (DEFAULT_MAX_INLINE_TOOL_OUTPUT_CHARS - TOOL_OUTPUT_READ_ENVELOPE_RESERVE_CHARS) / 6,
);

// A retained ref must always leave enough serialized room for at least one
// content segment. Validate provenance before issuing the ref instead of
// creating a continuation that the reader can never deliver.
export const MAX_TOOL_OUTPUT_SOURCE_METADATA_JSON_CHARS = 100_000;
