import type { ConversationOwner } from "../../../domain/execution-scope/index.js";
import { memoryOwnersForConversation, type MemoryOwner } from "../../../domain/memory/index.js";
import type { ToolExecutor } from "../../../domain/tools/index.js";
import type { AgentToolRegistryContribution } from "../../tool-center/factory.js";
import type { HistoryQueryPort } from "../contracts.js";
import {
  HISTORY_READ_DEFAULT_TOKENS,
  HISTORY_READ_MAX_TOKENS,
  HISTORY_SEARCH_MAX_ITEMS,
} from "./history-query-port.js";

/**
 * search_history / read_history 工具（正式设计 §10）：Active 历史的唯一读取口。
 *
 * - scope 从宿主注入的会话 owner 派生（space owner），模型不能选择 Space；
 * - 工具描述只描述能力，不编写"出现某类词必须调用"的触发策略；
 * - 返回 coverage 与结构化失败；主模型不调用时工程不补偿。
 */

export type MemoryHistoryToolOptions = {
  readonly historyQueryPort: HistoryQueryPort;
  /** Undefined only while CapabilityCenter builds a catalog without a run. */
  readonly owner?: ConversationOwner;
};

/** 会话的 Space memory owner；workspace 会话没有长期记忆（返回 undefined）。 */
export function spaceMemoryOwnerOf(owner: ConversationOwner | undefined): MemoryOwner | undefined {
  if (owner === undefined) return undefined;
  return memoryOwnersForConversation(owner).find((candidate) => candidate.kind === "space");
}

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
        "Search prior conversations of this Space (curated conversation summaries and raw user/assistant excerpts). " +
        "Use it when past discussions, decisions or details may matter to the current task. " +
        "Returns bounded excerpts with conversation id and time; coverage states whether each source was fully searched.",
      metadata: { category: "workspace", riskLevel: "low", operationType: "read-only", requiresConfirmation: false },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language query." },
          conversationId: { type: "string", description: "Optional conversation to restrict the search to." },
          source: { type: "string", enum: ["summary", "transcript", "all"], description: "Which sources to search (default all)." },
          limit: { type: "number", minimum: 1, maximum: HISTORY_SEARCH_MAX_ITEMS, description: "Maximum excerpts (default 8)." },
        },
        required: ["query"],
      },
    },
    async execute(input) {
      const owner = spaceMemoryOwnerOf(options.owner);
      if (owner === undefined) {
        return { status: "ok", outcome: "no_hit", coverage: { summary: "disabled", transcript: "disabled" }, items: [] };
      }
      const record = asRecordLike(input);
      const query = stringOrUndefinedLike(record.query);
      if (query === undefined || query.trim().length === 0) {
        return { status: "invalid_input", message: "query must be a non-empty string." };
      }
      const source = parseSource(record.source);
      const limit = optionalLimit(record.limit, HISTORY_SEARCH_MAX_ITEMS);
      const conversationId = stringOrUndefinedLike(record.conversationId);
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
        "Read the curated summary or the raw transcript of one prior conversation in this Space. " +
        "Use it after search_history when you need more complete context around a match.",
      metadata: { category: "workspace", riskLevel: "low", operationType: "read-only", requiresConfirmation: false },
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string", description: "Conversation id returned by search_history." },
          source: { type: "string", enum: ["summary", "transcript"], description: "summary = curated digest, transcript = raw user/assistant messages." },
          fromOrdinal: { type: "number", minimum: 1, description: "Transcript continuation position returned by a previous read." },
          fragmentStart: { type: "number", minimum: 0, description: "Character offset inside fromOrdinal's turn stream returned by a previous read (fragment continuation)." },
          limitTokens: { type: "number", minimum: 1, maximum: HISTORY_READ_MAX_TOKENS, description: "Maximum tokens to return (default 4000)." },
        },
        required: ["conversationId", "source"],
      },
    },
    async execute(input) {
      const owner = spaceMemoryOwnerOf(options.owner);
      if (owner === undefined) {
        return { status: "ok", outcome: "unavailable", reason: "memory_scope_unavailable" };
      }
      const record = asRecordLike(input);
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
      const limitTokens = optionalLimit(record.limitTokens, HISTORY_READ_DEFAULT_TOKENS);
      const result = await options.historyQueryPort.read({
        owner,
        conversationId,
        source,
        ...(fromOrdinal === undefined ? {} : { fromOrdinal }),
        ...(fragmentStart === undefined ? {} : { fragmentStart }),
        limitTokens,
      });
      return { status: "ok", ...result };
    },
  };
}

function parseSource(value: unknown): "summary" | "transcript" | "all" {
  if (value === "summary" || value === "transcript" || value === "all") return value;
  return "all";
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
