import type { ConversationOwner } from "../../domain/execution-scope/index.js";
import { memoryOwnerKey, memoryOwnersForConversation, type MemoryOwner } from "../../domain/memory/index.js";
import type { ToolExecutionContext, ToolExecutor } from "../../domain/tools/index.js";
import { asRecord, stringOrUndefined } from "../../kernel/values/index.js";
import type { AgentToolRegistryContribution } from "../tool-center/factory.js";
import {
  assertPathDependencyMemoryId,
  PATH_DEPENDENCY_MAX_EVIDENCE_REFS,
  PATH_DEPENDENCY_MAX_METHODOLOGY_CHARS,
  PATH_DEPENDENCY_MAX_TAG_CHARS,
  PATH_DEPENDENCY_MAX_TAGS,
  PATH_DEPENDENCY_MAX_TITLE_CHARS,
  PathDependencyFeatureError,
  type PathDependency,
  type PathDependencyFeature,
  type PathDependencySourceRef,
} from "./contracts.js";
import {
  exceedsPathDependencyReadBudget,
  fitPathDependencySearchMatches,
  PATH_DEPENDENCY_SEARCH_MAX_RESULTS,
  type PathDependencyTokenCounter,
} from "./progressive-disclosure.js";

export type OrdinaryMemoryFactSink = {
  recordRead(input: {
    readonly factId: string;
    readonly memoryId: string;
    readonly revision: number;
    readonly title: string;
    readonly owner: MemoryOwner;
  }): Promise<void>;
  recordReference(input: {
    readonly factId: string;
    readonly memoryId: string;
    readonly revision: number;
    readonly title: string;
    readonly owner: MemoryOwner;
    readonly note?: string;
  }): Promise<"recorded" | "already_recorded" | "not_read">;
};

export type PathDependencyToolOptions = {
  readonly dependencies: Pick<PathDependencyFeature, "commands" | "queries">;
  /** Undefined only while CapabilityCenter builds a catalog without a run. */
  readonly owner?: ConversationOwner;
  /** Host-owned run identity; the model cannot supply or replace provenance. */
  readonly run?: {
    readonly runId: string;
    readonly conversationId: string;
  };
  readonly memoryFacts?: OrdinaryMemoryFactSink;
  /** Host-selected tokenizer for this run; fallback counting remains deterministic. */
  readonly countMemoryTokens?: PathDependencyTokenCounter;
};

/**
 * The read tools are progressive disclosure controls, not a deterministic task
 * router. They query only the frozen global + direct Conversation owner scopes.
 */
export function createPathDependencyToolRegistryContribution(
  options: PathDependencyToolOptions,
): AgentToolRegistryContribution {
  return (register) => {
    for (const executor of createPathDependencyTools(options)) {
      register({ executor, scopes: ["agent-basic"], enabledByDefault: true });
    }
  };
}

export function createPathDependencyTools(options: PathDependencyToolOptions): readonly ToolExecutor[] {
  return [
    memorySearchTool(options),
    memoryReadTool(options),
    memoryReferenceTool(options),
    pathDependencySaveTool(options),
  ];
}

function memorySearchTool(options: PathDependencyToolOptions): ToolExecutor {
  return {
    definition: {
      name: "MemorySearch",
      description:
        "Search reusable path dependencies (task methodologies) visible to this run. " +
        "Use it when the task may match a previously learned method. Results are candidates only; search does not mean a memory was used.",
      metadata: { category: "workspace", riskLevel: "low", operationType: "read-only", requiresConfirmation: false },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Task words, technology, or method to search for." },
          limit: { type: "number", minimum: 1, maximum: PATH_DEPENDENCY_SEARCH_MAX_RESULTS, description: "Maximum candidates to return (default 8)." },
        },
        required: ["query"],
      },
    },
    async execute(input) {
      const access = runAccess(options);
      if ("error" in access) return access.error;
      const record = asRecord(input);
      const query = stringOrUndefined(record.query);
      if (query === undefined) return { status: "invalid_input", message: "query must be a non-empty string." };
      const limit = optionalPositiveLimit(record.limit, 8);
      if (limit === undefined) return { status: "invalid_input", message: `limit must be an integer from 1 through ${PATH_DEPENDENCY_SEARCH_MAX_RESULTS}.` };
      const results = await options.dependencies.queries.search({ text: query, owners: access.owners, limit });
      const budgeted = fitPathDependencySearchMatches(results, options.countMemoryTokens);
      return {
        status: "ok",
        candidates: budgeted.map((result) => ({
          id: result.dependency.id,
          kind: "path_dependency",
          title: result.dependency.title,
          owner: result.dependency.owner,
          revision: result.dependency.revision,
          verification: result.dependency.verification.status,
          tags: result.dependency.tags,
          score: result.score,
          matchedFields: result.matchedFields,
          excerpt: result.dependency.methodology.slice(0, 360),
        })),
      };
    },
  };
}

function memoryReadTool(options: PathDependencyToolOptions): ToolExecutor {
  return {
    definition: {
      name: "MemoryRead",
      description:
        "Read one reusable path dependency in full. This records that this run read the exact returned revision; it does not itself claim adoption. " +
        "Use MemoryReference separately if you actively rely on the method.",
      metadata: { category: "workspace", riskLevel: "low", operationType: "read-only", requiresConfirmation: false },
      inputSchema: {
        type: "object",
        properties: {
          memoryId: { type: "string", description: "Opaque id returned by the memory directory or MemorySearch." },
          revision: { type: "number", minimum: 1, description: "Optional revision you intend to read; detects a changed method." },
        },
        required: ["memoryId"],
      },
    },
    async execute(input, context) {
      const access = runAccess(options);
      if ("error" in access) return access.error;
      const record = asRecord(input);
      const memoryId = opaqueMemoryIdOrUndefined(record.memoryId);
      const requestedRevision = optionalRevision(record.revision);
      if (memoryId === undefined) return invalidMemoryIdInput();
      if (record.revision !== undefined && requestedRevision === undefined) return { status: "invalid_input", message: "revision must be a positive integer." };
      let dependency: PathDependency | undefined;
      try {
        dependency = await options.dependencies.queries.get(memoryId);
      } catch (error) {
        const invalid = invalidPathDependencyInput(error);
        if (invalid !== undefined) return invalid;
        throw error;
      }
      if (dependency === undefined) return { status: "memory_not_found", memoryId, message: "This path dependency is unavailable, possibly because it was deleted." };
      if (!allowsOwner(access.owners, dependency.owner)) return { status: "memory_not_available", memoryId, message: "This memory is outside the frozen scope of this run." };
      if (requestedRevision !== undefined && dependency.revision !== requestedRevision) {
        return {
          status: "memory_revision_changed",
          memoryId,
          requestedRevision,
          currentRevision: dependency.revision,
          title: dependency.title,
          message: "The method changed after the revision you selected. Read the current revision deliberately before using it.",
        };
      }
      const output = fullReadOutput(dependency);
      if (exceedsPathDependencyReadBudget(output, options.countMemoryTokens)) {
        return {
          status: "memory_read_budget_exceeded",
          memoryId: dependency.id,
          revision: dependency.revision,
          message: "This memory is larger than the run's complete-read budget. The body was not summarized or marked as read; revise the memory into a smaller methodology before reading it.",
        };
      }
      if (options.memoryFacts === undefined) return memoryFactSinkUnavailable();
      const factId = memoryFactId(context, "read", dependency);
      await options.memoryFacts.recordRead({
        factId,
        memoryId: dependency.id,
        revision: dependency.revision,
        title: dependency.title,
        owner: dependency.owner,
      });
      return output;
    },
  };
}

function memoryReferenceTool(options: PathDependencyToolOptions): ToolExecutor {
  return {
    definition: {
      name: "MemoryReference",
      description:
        "Record that you are deliberately applying a path dependency you read in this run. " +
        "This does not modify the memory. Do not call it merely because a search result looked relevant.",
      metadata: { category: "workspace", riskLevel: "low", operationType: "read-write", requiresConfirmation: false },
      inputSchema: {
        type: "object",
        properties: {
          memoryId: { type: "string", description: "The id of a dependency already read in this run." },
          revision: { type: "number", minimum: 1, description: "Exact revision returned by MemoryRead." },
          note: { type: "string", description: "Optional short explanation of how this method informs the current task." },
        },
        required: ["memoryId", "revision"],
      },
    },
    async execute(input, context) {
      const access = runAccess(options);
      if ("error" in access) return access.error;
      const record = asRecord(input);
      const memoryId = opaqueMemoryIdOrUndefined(record.memoryId);
      const revision = optionalRevision(record.revision);
      const note = record.note === undefined ? undefined : stringOrUndefined(record.note);
      if (memoryId === undefined || revision === undefined) return { status: "invalid_input", message: "memoryId must be an opaque id and revision must be a positive integer." };
      if (record.note !== undefined && note === undefined) return { status: "invalid_input", message: "note must be a non-empty string when provided." };
      let dependency: PathDependency | undefined;
      try {
        dependency = await options.dependencies.queries.get(memoryId);
      } catch (error) {
        const invalid = invalidPathDependencyInput(error);
        if (invalid !== undefined) return invalid;
        throw error;
      }
      if (dependency === undefined) return { status: "memory_not_found", memoryId, message: "This path dependency is unavailable, possibly because it was deleted." };
      if (!allowsOwner(access.owners, dependency.owner)) return { status: "memory_not_available", memoryId, message: "This memory is outside the frozen scope of this run." };
      if (dependency.revision !== revision) return { status: "memory_revision_changed", memoryId, requestedRevision: revision, currentRevision: dependency.revision };
      if (options.memoryFacts === undefined) return memoryFactSinkUnavailable();
      const recorded = await options.memoryFacts.recordReference({
        factId: memoryFactId(context, "applied", dependency),
        memoryId: dependency.id,
        revision,
        title: dependency.title,
        owner: dependency.owner,
        ...(note === undefined ? {} : { note }),
      });
      if (recorded === "not_read") return { status: "memory_not_read_in_run", memoryId, revision, message: "This exact revision was not durably read by the run." };
      return { status: recorded === "already_recorded" ? "already_referenced" : "referenced", memoryId, revision };
    },
  };
}

function pathDependencySaveTool(options: PathDependencyToolOptions): ToolExecutor {
  return {
    definition: {
      name: "PathDependencySave",
      description:
        "Save a reusable task methodology for future similar work. Save the method, applicability, verification approach and failure boundary—not transcript, raw tool steps, temporary paths, secrets, or a blind replay script. " +
        "Use scope \"owner\" for this current Space/Workspace or \"global\" only for a genuinely cross-project method. Updating a memory requires its current expectedRevision.",
      metadata: { category: "workspace", riskLevel: "low", operationType: "read-write", requiresConfirmation: false },
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["owner", "global"] },
          memoryId: { type: "string", description: "Omit to create. Include to update the same dependency." },
          expectedRevision: { type: "number", minimum: 1, description: "Required when memoryId updates an existing dependency." },
          title: { type: "string", description: "Short recognizable task-method title." },
          methodology: { type: "string", description: "Reusable method with applicability, validation, and failure boundaries." },
          tags: { type: "array", items: { type: "string" }, description: "Optional retrieval tags." },
          verification: { type: "string", enum: ["not_recorded", "observed"] },
          evidenceRefs: { type: "array", items: { type: "string" }, description: "Optional durable evidence references; do not paste evidence bodies." },
        },
        required: ["scope", "title", "methodology"],
      },
    },
    async execute(input, _context) {
      const access = runAccess(options);
      if ("error" in access) return access.error;
      const record = asRecord(input);
      const scope = stringOrUndefined(record.scope);
      const title = stringOrUndefined(record.title);
      const methodology = stringOrUndefined(record.methodology);
      const memoryId = record.memoryId === undefined ? undefined : opaqueMemoryIdOrUndefined(record.memoryId);
      const expectedRevision = record.expectedRevision === undefined ? undefined : optionalRevision(record.expectedRevision);
      const tags = boundedStringArrayOrUndefined(record.tags, PATH_DEPENDENCY_MAX_TAGS, PATH_DEPENDENCY_MAX_TAG_CHARS);
      const evidenceRefs = boundedStringArrayOrUndefined(record.evidenceRefs, PATH_DEPENDENCY_MAX_EVIDENCE_REFS, 512);
      const verificationValue = record.verification === undefined ? undefined : stringOrUndefined(record.verification);
      const verification = isVerificationStatus(verificationValue) ? verificationValue : undefined;
      if (scope !== "owner" && scope !== "global") return { status: "invalid_input", message: 'scope must be "owner" or "global".' };
      if (title === undefined || title.length > PATH_DEPENDENCY_MAX_TITLE_CHARS || methodology === undefined || methodology.length > PATH_DEPENDENCY_MAX_METHODOLOGY_CHARS) {
        return { status: "invalid_input", message: "title and methodology must be non-empty strings within their maximum lengths." };
      }
      if (record.memoryId !== undefined && memoryId === undefined) return invalidMemoryIdInput();
      if (record.expectedRevision !== undefined && expectedRevision === undefined) return { status: "invalid_input", message: "expectedRevision must be a positive integer when provided." };
      if (memoryId !== undefined && expectedRevision === undefined) {
        return { status: "invalid_input", message: "expectedRevision is required when memoryId is provided for an update." };
      }
      if (tags === undefined && record.tags !== undefined || evidenceRefs === undefined && record.evidenceRefs !== undefined) return { status: "invalid_input", message: "tags and evidenceRefs must be arrays of non-empty strings." };
      if (record.verification !== undefined && verification === undefined) return { status: "invalid_input", message: "verification is invalid." };
      if (options.run === undefined) return { status: "memory_run_unavailable", message: "This tool is not attached to a concrete Ordinary run and cannot create provenance." };
      const sourceRunRef = hostSourceRunRef(options.run);
      if (sourceRunRef === undefined) return { status: "invalid_input", message: "host run provenance is invalid." };
      const owner = scope === "global" ? ({ kind: "global" } as const) : access.owner;
      try {
        const result = await options.dependencies.commands.save({
          owner,
          ...(memoryId === undefined ? {} : { memoryId }),
          title,
          methodology,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          ...(tags === undefined ? {} : { tags }),
          ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
          ...(verification === undefined ? {} : {
            verification: {
              status: verification,
            },
          }),
          sourceRunRefs: [sourceRunRef],
          createdBy: "agent",
        });
        if (result.status === "conflict") {
          return {
            status: "revision_conflict",
            current: compactDependency(result.current),
            message: "The dependency changed. Read the current version, merge deliberately, then retry with expectedRevision.",
          };
        }
        return {
          status: result.status,
          dependency: compactDependency(result.dependency),
        };
      } catch (error) {
        const invalid = invalidPathDependencyInput(error);
        if (invalid !== undefined) return invalid;
        if (error instanceof PathDependencyFeatureError && error.code === "path_dependency_owner_deleted") {
          return { status: "memory_owner_deleted", message: error.message };
        }
        if (error instanceof PathDependencyFeatureError && error.code === "path_dependency_revision_conflict") {
          return { status: "revision_conflict", message: error.message };
        }
        if (error instanceof PathDependencyFeatureError && error.code === "path_dependency_not_found") {
          return { status: "memory_not_found", message: error.message };
        }
        throw error;
      }
    },
  };
}

function runAccess(options: PathDependencyToolOptions): { readonly owner: ConversationOwner; readonly owners: readonly MemoryOwner[] } | { readonly error: { readonly status: "memory_scope_unavailable"; readonly message: string } } {
  if (options.owner === undefined) return { error: { status: "memory_scope_unavailable", message: "This tool has no frozen conversation owner and cannot access memory." } };
  return { owner: options.owner, owners: memoryOwnersForConversation(options.owner) };
}

function memoryFactSinkUnavailable(): { readonly status: "memory_fact_sink_unavailable"; readonly message: string } {
  return {
    status: "memory_fact_sink_unavailable",
    message: "This run cannot durably record memory facts, so the memory was not returned as read or applied.",
  };
}

function fullReadOutput(dependency: PathDependency): object {
  return {
    status: "ok",
    memory: {
      id: dependency.id,
      kind: "path_dependency",
      owner: dependency.owner,
      title: dependency.title,
      methodology: dependency.methodology,
      sourceRunRefs: dependency.sourceRunRefs,
      verification: dependency.verification,
      evidenceRefs: dependency.evidenceRefs,
      revision: dependency.revision,
      contentVersion: dependency.contentVersion,
      tags: dependency.tags,
      updatedAt: dependency.updatedAt,
    },
  };
}

function compactDependency(dependency: PathDependency): object {
  return {
    id: dependency.id,
    owner: dependency.owner,
    title: dependency.title,
    revision: dependency.revision,
    contentVersion: dependency.contentVersion,
    updatedAt: dependency.updatedAt,
  };
}

function allowsOwner(owners: readonly MemoryOwner[], owner: MemoryOwner): boolean {
  const key = memoryOwnerKey(owner);
  return owners.some((allowed) => memoryOwnerKey(allowed) === key);
}

function memoryFactId(context: ToolExecutionContext, kind: "read" | "applied", dependency: Pick<PathDependency, "id" | "revision">): string {
  return `${context.traceId}:${context.providerCallId ?? context.invocationId ?? `${kind}:${dependency.id}@${dependency.revision}`}:${kind}`;
}

function optionalPositiveLimit(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= PATH_DEPENDENCY_SEARCH_MAX_RESULTS ? value : undefined;
}

function optionalRevision(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function opaqueMemoryIdOrUndefined(value: unknown): string | undefined {
  const memoryId = stringOrUndefined(value);
  if (memoryId === undefined) return undefined;
  try {
    assertPathDependencyMemoryId(memoryId);
    return memoryId;
  } catch {
    return undefined;
  }
}

function invalidMemoryIdInput(): { readonly status: "invalid_input"; readonly message: string } {
  return {
    status: "invalid_input",
    message: "memoryId must be a non-empty opaque id without path separators or control characters.",
  };
}

function invalidPathDependencyInput(error: unknown): { readonly status: "invalid_input"; readonly message: string } | undefined {
  if (error instanceof PathDependencyFeatureError && error.code === "path_dependency_invalid_input") {
    return { status: "invalid_input", message: error.message };
  }
  return undefined;
}

function boundedStringArrayOrUndefined(value: unknown, maxItems: number, maxItemChars: number): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string" || item.trim().length === 0 || item.length > maxItemChars) return undefined;
  }
  return value;
}

function isVerificationStatus(value: unknown): value is "not_recorded" | "observed" {
  return value === "not_recorded" || value === "observed";
}

function hostSourceRunRef(run: PathDependencyToolOptions["run"]): PathDependencySourceRef | undefined {
  const record = asRecord(run);
  const runId = stringOrUndefined(record.runId);
  const conversationId = stringOrUndefined(record.conversationId);
  if (runId === undefined || runId.length > 256 || conversationId === undefined || conversationId.length > 256) return undefined;
  return {
    runId,
    conversationId,
  };
}
