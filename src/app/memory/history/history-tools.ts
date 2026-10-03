import type { ConversationOwner } from "../../../domain/execution-scope/index.js";
import type { ToolExecutor } from "../../../domain/tools/index.js";
import type { AgentToolRegistryContribution } from "../../tool-center/factory.js";
import type { HistoryQueryPort } from "../contracts.js";
import {
  HISTORY_READ_DEFAULT_TOKENS,
  HISTORY_READ_MAX_TOKENS,
  HISTORY_SEARCH_MAX_ITEMS,
} from "./history-query-port.js";

/**
 * search_history / read_history 工具（正式设计 §10，ADR 0018）：Active 历史的唯一读取口。
 *
 * - scope 是宿主注入的结构化 Space owner，模型不能选择 owner；
 * - 工具描述只描述能力，不编写"出现某类词必须调用"的触发策略；
 * - 返回 coverage 与结构化失败；主模型不调用时工程不补偿。
 */

export type MemoryHistoryToolOptions = {
  readonly historyQueryPort: HistoryQueryPort;
  /** Undefined only while CapabilityCenter builds a catalog without a run. */
  readonly owner?: ConversationOwner;
};

export function createMemoryHistoryToolRegistryContribution(
  options: MemoryHistoryToolOptions,
): AgentToolRegistryContribution {
  return (register) => {
    for (const executor of createMemoryHistoryTools(options)) {
      register({ executor, scopes: ["agent-basic"], enabledByDefault: true });
    }
  };
}

export function createMemoryHistoryTools(options: MemoryHistoryToolOptions): readonly ToolExecutor[] {
  return [searchHistoryTool(options), readHistoryTool(options)];
}

function searchHistoryTool(options: MemoryHistoryToolOptions): ToolExecutor {
  return {
    definition: {
      name: "search_history",
      description:
        "Search published memory entries of this Space, or conversation summaries and raw excerpts. " +
        "Memory revisions include current/historical roles, event/report/publication times and dynamically checked sources. " +
        "contentPage and sourcePage identify partial content/source fields; continue with the cursor to retrieve every field and source. " +
        "Use source=memory (default) for recognition, source=summary/transcript/all for prior conversations; use returned cursors to continue.",
      metadata: { category: "workspace", riskLevel: "low", operationType: "read-only", requiresConfirmation: false },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language query." },
          conversationId: { type: "string", description: "Optional conversation to restrict the search to." },
          source: { type: "string", enum: ["memory", "summary", "transcript", "all"], description: "Published memory entries (default memory), conversation summaries, raw transcripts or both history sources." },
          topicId: { type: "string", description: "Optional memory topic id." },
          includeHistory: { type: "boolean", description: "Include historical or withdrawn memory revisions, with explicit roles (default false)." },
          cursor: { type: "string", description: "Opaque continuation returned by a memory entry search." },
          limit: { type: "number", minimum: 1, maximum: HISTORY_SEARCH_MAX_ITEMS, description: "Maximum excerpts (default 8)." },
        },
        required: ["query"],
      },
    },
    async execute(input) {
      const owner = options.owner;
      if (owner === undefined) {
        return { status: "ok", outcome: "unavailable", reason: "memory_scope_unavailable", items: [], nextCursor: null, truncated: false };
      }
      const record = asRecordLike(input);
      const query = stringOrUndefinedLike(record.query);
      if (query === undefined || query.trim().length === 0) {
        return { status: "invalid_input", message: "query must be a non-empty string." };
      }
      const source = parseSource(record.source);
      const limit = optionalLimit(record.limit, HISTORY_SEARCH_MAX_ITEMS);
      const conversationId = stringOrUndefinedLike(record.conversationId);
      if (source === "memory") {
        const topicId = stringOrUndefinedLike(record.topicId);
        const cursor = stringOrUndefinedLike(record.cursor);
        const result = await options.historyQueryPort.searchEntries({ owner, query, limit,
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(topicId === undefined ? {} : { topicId }),
          ...(cursor === undefined ? {} : { cursor }),
          includeHistory: record.includeHistory === true,
        });
        return { status: "ok", ...result };
      }
      const result = await options.historyQueryPort.search({
        owner,
        query,
        ...(conversationId === undefined ? {} : { conversationId }),
        sources: source,
        limit,
      });
      return { status: "ok", ...result };
    },
  };
}

function readHistoryTool(options: MemoryHistoryToolOptions): ToolExecutor {
  return {
    definition: {
      name: "read_history",
      description:
        "Read a published memory entry by entryId (optional immutable revision, history and one-hop related entries), " +
        "or a prior conversation summary/transcript in this owner. Deleted sources do not revoke recognition but cannot be read back. " +
        "contentPage and sourcePage mark slices of content and sources; empty body on a source continuation does not withdraw the entry. " +
        "Use returned continuation positions for complete bounded reads.",
      metadata: { category: "workspace", riskLevel: "low", operationType: "read-only", requiresConfirmation: false },
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string", description: "Conversation id returned by search_history." },
          source: { type: "string", enum: ["memory", "summary", "transcript"], description: "memory = published entry, summary = curated digest, transcript = raw messages." },
          entryId: { type: "string", description: "Published memory entry id; selects the memory branch." },
          revisionId: { type: "string", description: "Optional immutable memory revision id; historical reads require includeHistory." },
          includeHistory: { type: "boolean", description: "Read older revisions with their historical/withdrawn roles." },
          includeRelated: { type: "boolean", description: "Include at most one hop of related current entries within the same budget." },
          cursor: { type: "string", description: "Opaque continuation returned by read_history for this entry." },
          fromOrdinal: { type: "number", minimum: 1, description: "Transcript continuation position returned by a previous read." },
          fragmentStart: { type: "number", minimum: 0, description: "Character offset inside fromOrdinal's turn stream returned by a previous read (fragment continuation)." },
          limitTokens: { type: "number", minimum: 1, maximum: HISTORY_READ_MAX_TOKENS, description: "Maximum tokens to return (default 4000)." },
        },
        anyOf: [{ required: ["entryId"] }, { required: ["conversationId", "source"] }],
      },
    },
    async execute(input) {
      const owner = options.owner;
      if (owner === undefined) {
        return { status: "ok", outcome: "unavailable", reason: "memory_scope_unavailable" };
      }
      const record = asRecordLike(input);
      const entryId = stringOrUndefinedLike(record.entryId);
      const limitTokens = Math.min(HISTORY_READ_MAX_TOKENS, optionalLimit(record.limitTokens, HISTORY_READ_DEFAULT_TOKENS));
      if (entryId !== undefined || record.source === "memory") {
        if (entryId === undefined) return { status: "invalid_input", message: "entryId is required for memory reads." };
        const revisionId = stringOrUndefinedLike(record.revisionId);
        const cursor = stringOrUndefinedLike(record.cursor);
        const result = await options.historyQueryPort.readEntry({ owner, entryId, limitTokens,
          ...(revisionId === undefined ? {} : { revisionId }),
          ...(cursor === undefined ? {} : { cursor }),
          includeHistory: record.includeHistory === true, includeRelated: record.includeRelated === true,
        });
        return { status: "ok", ...result };
      }
      const conversationId = stringOrUndefinedLike(record.conversationId);
      if (conversationId === undefined) {
        return { status: "invalid_input", message: "conversationId must be a non-empty string." };
      }
      const source = record.source === "transcript" ? "transcript" : record.source === "summary" ? "summary" : undefined;
      if (source === undefined) {
        return { status: "invalid_input", message: "source must be 'summary' or 'transcript'." };
      }
      const fromOrdinal = optionalPositiveNumber(record.fromOrdinal);
      const fragmentStart = optionalNonNegativeNumber(record.fragmentStart);
      const result = await options.historyQueryPort.read({
        owner,
        conversationId,
        source,
        ...(fromOrdinal === undefined ? {} : { fromOrdinal }),
        ...(fragmentStart === undefined ? {} : { fragmentStart }),
        ...(typeof record.cursor === "string" ? { cursor: record.cursor } : {}),
        limitTokens,
      });
      return { status: "ok", ...result };
    },
  };
}

function parseSource(value: unknown): "memory" | "summary" | "transcript" | "all" {
  if (value === "summary" || value === "transcript" || value === "all") return value;
  return "memory";
}

function optionalLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

/** 工具层输入解析（不引入 kernel/values 之外的依赖面）。 */
function asRecordLike(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrUndefinedLike(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
