import type { ToolDefinition, ToolExecutionContext, ToolExecutor } from "../../domain/tools/index.js";
import { asRecord, numberOrUndefined, stringOrUndefined } from "../../kernel/values/index.js";
import type { AgentToolRegistryContribution } from "../tool-center/factory.js";
import { PersonalKnowledgeError, type KnowledgePage, type PersonalKnowledgeFeature } from "./contracts.js";

export type PersonalKnowledgeToolOptions = {
  readonly knowledge: Pick<PersonalKnowledgeFeature, "commands" | "queries">;
};

export function createPersonalKnowledgeTools(options: PersonalKnowledgeToolOptions): readonly ToolExecutor[] {
  return [
    createKnowledgeSearchTool(options),
    createKnowledgeReadTool(options),
    createKnowledgeCreateNoteTool(options),
    createKnowledgeUpdateNoteTool(options),
    createKnowledgeDeleteNoteTool(options),
    createKnowledgeCollectTool(options),
    createKnowledgeListTool(options),
    createKnowledgeReadPageTool(options),
    createKnowledgeUpdateAssetTextTool(options),
    createKnowledgeUncollectTool(options),
    createKnowledgeCreateThemeTool(options),
    createKnowledgeAssignThemeTool(options),
    createKnowledgeUnassignThemeTool(options),
    createKnowledgeNoteHistoryTool(options),
    createKnowledgeRestoreNoteTool(options),
  ];
}

export function createPersonalKnowledgeToolRegistryContribution(
  options: PersonalKnowledgeToolOptions,
): AgentToolRegistryContribution {
  return (register) => {
    for (const executor of createPersonalKnowledgeTools(options)) {
      register({ executor, scopes: ["agent-basic"], enabledByDefault: true });
    }
  };
}

export function createKnowledgeSearchTool(options: PersonalKnowledgeToolOptions): ToolExecutor {
  return tool({
    name: "KnowledgeSearch",
    description: "Search the user's persisted personal Markdown notes by title and body. Results include stable note ids, Space ids, revision facts, and bounded matching snippets.",
    metadata: readMetadata,
    inputSchema: schema({
      query: { type: "string", description: "Required search text." },
      spaceId: { type: "string", description: "Optional Space id filter." },
      limit: { type: "number", description: "Optional result limit from 1 to 100. Defaults to 20." },
    }, ["query"]),
    execute: async (input) => {
      const record = asRecord(input);
      const query = stringOrUndefined(record.query);
      const spaceId = optionalString(record.spaceId);
      const limit = optionalInteger(record.limit);
      if (query === undefined || spaceId === null || limit === null) {
        return invalid("query must be a string; spaceId and limit must be omitted or valid values.");
      }
      return resultFor(
        () => options.knowledge.queries.search({ query, spaceId, limit }),
        (results) => ({ status: "found", count: results.length, results }),
      );
    },
  });
}

export function createKnowledgeReadTool(options: PersonalKnowledgeToolOptions): ToolExecutor {
  return tool({
    name: "KnowledgeRead",
    description: "Read one persisted personal Markdown note by its stable note id, including its current revision.",
    metadata: readMetadata,
    inputSchema: schema({ noteId: { type: "string" } }, ["noteId"]),
    execute: async (input) => {
      const noteId = stringOrUndefined(asRecord(input).noteId);
      if (noteId === undefined) return invalid("noteId must be a string.");
      const note = await options.knowledge.queries.note(noteId);
      return note === undefined ? { status: "personal_note_not_found", noteId } : { status: "found", note };
    },
  });
}

export function createKnowledgeCreateNoteTool(options: PersonalKnowledgeToolOptions): ToolExecutor {
  return tool({
    name: "KnowledgeCreateNote",
    description: "Create a persisted personal Markdown note in an existing Space. This creates knowledge content, not an external filesystem file.",
    metadata: writeMetadata,
    inputSchema: schema({
      spaceId: { type: "string" },
      title: { type: "string" },
      bodyMarkdown: { type: "string" },
    }, ["spaceId"]),
    execute: async (input, context) => {
      const record = asRecord(input);
      const spaceId = stringOrUndefined(record.spaceId);
      const title = optionalString(record.title);
      const bodyMarkdown = optionalString(record.bodyMarkdown);
      if (spaceId === undefined || title === null || bodyMarkdown === null) {
        return invalid("spaceId is required; title and bodyMarkdown must be omitted or valid values.");
      }
      return resultFor(
        () => options.knowledge.commands.createNote({ spaceId, title, bodyMarkdown, actor: agentActor(context) }),
        (note) => ({ status: "created", note }),
      );
    },
  });
}

export function createKnowledgeUpdateNoteTool(options: PersonalKnowledgeToolOptions): ToolExecutor {
  return tool({
    name: "KnowledgeUpdateNote",
    description: "Update the title or Markdown body of a personal note using the revision returned by KnowledgeRead or KnowledgeSearch. A stale revision is rejected and never overwrites newer content.",
    metadata: writeMetadata,
    inputSchema: schema({
      noteId: { type: "string" },
      expectedRevision: { type: "number" },
      title: { type: "string" },
      bodyMarkdown: { type: "string" },
    }, ["noteId", "expectedRevision"]),
    execute: async (input, context) => {
      const record = asRecord(input);
      const noteId = stringOrUndefined(record.noteId);
      const expectedRevision = integer(record.expectedRevision);
      const title = optionalString(record.title);
      const bodyMarkdown = optionalString(record.bodyMarkdown);
      if (noteId === undefined || expectedRevision === undefined || title === null || bodyMarkdown === null) {
        return invalid("noteId and expectedRevision are required; title and bodyMarkdown must be omitted or strings.");
      }
      if (title === undefined && bodyMarkdown === undefined) return invalid("title or bodyMarkdown is required.");
      return resultFor(
        () => options.knowledge.commands.updateNote({ id: noteId, expectedRevision, title, bodyMarkdown, actor: agentActor(context) }),
        () => ({ status: "updated", noteId, revision: expectedRevision + 1 }),
      );
    },
  });
}

export function createKnowledgeNoteHistoryTool(options: PersonalKnowledgeToolOptions): ToolExecutor {
  return tool({
    name: "KnowledgeNoteHistory",
    description: "List the revision history of a personal note, newest first. Each entry carries the revision number, base revision, operation (create/update/delete/snapshot), change summary, actor and timestamp, plus the title and a bounded body preview so you can choose a targetRevision for KnowledgeRestoreNote.",
    metadata: readMetadata,
    inputSchema: schema({
      noteId: { type: "string" },
      limit: { type: "number", description: "Optional revision limit from 1 to 200. Defaults to 20." },
    }, ["noteId"]),
    execute: async (input) => {
      const record = asRecord(input);
      const noteId = stringOrUndefined(record.noteId);
      const limit = optionalInteger(record.limit);
      if (noteId === undefined || limit === null) {
        return invalid("noteId is required; limit must be omitted or an integer from 1 to 100.");
      }
      return resultFor(
        () => options.knowledge.queries.noteRevisions(noteId, limit ?? 20),
        (revisions) => ({ status: "found", noteId, count: revisions.length, revisions }),
      );
    },
  });
}

export function createKnowledgeRestoreNoteTool(options: PersonalKnowledgeToolOptions): ToolExecutor {
  return tool({
    name: "KnowledgeRestoreNote",
    description: "Restore a personal note to the full title and body of an earlier revision from KnowledgeNoteHistory, writing a new revision instead of rewriting history. Requires the current revision; a stale expectedRevision or a missing targetRevision is rejected and never overwrites newer content.",
    metadata: writeMetadata,
    inputSchema: schema({
      noteId: { type: "string" },
      expectedRevision: { type: "number", description: "Current revision of the note." },
      targetRevision: { type: "number", description: "Earlier revision whose title and body are restored." },
    }, ["noteId", "expectedRevision", "targetRevision"]),
    execute: async (input, context) => {
      const record = asRecord(input);
      const noteId = stringOrUndefined(record.noteId);
      const expectedRevision = integer(record.expectedRevision);
      const targetRevision = integer(record.targetRevision);
      if (noteId === undefined || expectedRevision === undefined || targetRevision === undefined) {
        return invalid("noteId, expectedRevision and targetRevision must be valid positive values.");
      }
      return resultFor(
        () => options.knowledge.commands.restoreNote({
          id: noteId,
          expectedRevision,
          targetRevision,
          actor: agentActor(context),
        }),
        () => ({ status: "restored", noteId, revision: expectedRevision + 1, targetRevision }),
      );
    },
  });
}

export function createKnowledgeDeleteNoteTool(options: PersonalKnowledgeToolOptions): ToolExecutor {
  return tool({
    name: "KnowledgeDeleteNote",
    description: "Delete a persisted personal Markdown note using the revision returned by KnowledgeRead or KnowledgeSearch. A stale revision is rejected and never deletes newer content.",
    metadata: destructiveMetadata,
    inputSchema: schema({
      noteId: { type: "string" },
      expectedRevision: { type: "number" },
    }, ["noteId", "expectedRevision"]),
    execute: async (input, context) => {
      const record = asRecord(input);
      const noteId = stringOrUndefined(record.noteId);
      const expectedRevision = integer(record.expectedRevision);
      if (noteId === undefined || expectedRevision === undefined) {
        return invalid("noteId and expectedRevision are required.");
      }
      return resultFor(
        () => options.knowledge.commands.deleteNote({ id: noteId, expectedRevision, actor: agentActor(context) }),
        () => ({ status: "deleted", noteId }),
      );
    },
  });
}

export function createKnowledgeCollectTool(options: PersonalKnowledgeToolOptions): ToolExecutor {
  return tool({
    name: "KnowledgeCollect",
    description: "Collect an existing personal note or Space reference into Brain. Space references are copied into software-managed knowledge storage so the collected content remains readable independently of the source.",
    metadata: writeMetadata,
    inputSchema: schema({
      refId: { type: "string" },
      kind: { type: "string", enum: ["note", "space_reference"] },
      relativePath: { type: "string", description: "Optional child file or folder path inside a Space folder reference." },
    }, ["refId", "kind"]),
    execute: async (input) => {
      const record = asRecord(input);
      const refId = stringOrUndefined(record.refId);
      const kind = knowledgePageKind(record.kind);
      const relativePath = record.relativePath === undefined ? undefined : stringOrUndefined(record.relativePath);
      if (refId === undefined || kind === undefined || (record.relativePath !== undefined && relativePath === undefined)) {
        return invalid("refId and a supported kind are required; relativePath must be a non-empty string when provided.");
      }
      const page: KnowledgePage = { refId, kind, collectedAt: Date.now() };
      return resultFor(
        () => kind === "space_reference"
          ? options.knowledge.commands.collectSpaceReference({ referenceId: refId, ...(relativePath === undefined ? {} : { relativePath }) })
          : options.knowledge.commands.execute({ type: "knowledge.collect", page }).then(() => page),
        (collected) => ({ status: "collected", page: collected }),
      );
    },
  });
}

export function createKnowledgeListTool(options: PersonalKnowledgeToolOptions): ToolExecutor {
  return tool({
    name: "KnowledgeList",
    description: "List the Personal Knowledge overview the Agent can operate on: all personal notes (collected or not), collected Space references, themes and theme assignments.",
    metadata: readMetadata,
    inputSchema: schema({
      query: { type: "string", description: "Optional title text filter." },
      kind: { type: "string", enum: ["note", "space_reference"], description: "Optional page kind filter." },
      spaceId: { type: "string", description: "Optional Space id filter; only notes belong to a Space." },
      themeId: { type: "string", description: "Optional theme id filter; only pages assigned to that theme are listed." },
      limit: { type: "number", description: "Optional page limit from 1 to 200. Defaults to 100." },
      cursor: { type: "string", description: "Opaque continuation cursor returned as nextInput of a previous call." },
    }, []),
    execute: async (input) => {
      const record = asRecord(input);
      const query = optionalString(record.query);
      const kind = knowledgeListKind(record.kind);
      const spaceId = optionalString(record.spaceId);
      const themeId = optionalString(record.themeId);
      const limit = optionalInteger(record.limit);
      const cursor = optionalString(record.cursor);
      if (query === null || kind === null || spaceId === null || themeId === null || limit === null || cursor === null) {
        return invalid("query, spaceId, themeId, limit and cursor must be omitted or valid values; kind must be note or space_reference.");
      }
      return resultFor(
        () => options.knowledge.queries.list({
          ...(query === undefined ? {} : { query }),
          ...(kind === undefined ? {} : { kind }),
          ...(spaceId === undefined ? {} : { spaceId }),
          ...(themeId === undefined ? {} : { themeId }),
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        }),
        (result) => ({ status: "found", ...result }),
      );
    },
  });
}

export function createKnowledgeReadPageTool(options: PersonalKnowledgeToolOptions): ToolExecutor {
  return tool({
    name: "KnowledgeReadPage",
    description: "Read one knowledge page by its stable refId from KnowledgeList or KnowledgeCollect. Notes return their current body and revision; collected Space references return managed file or directory content, media metadata or an explicit unreadable fact.",
    metadata: readMetadata,
    inputSchema: schema({
      refId: { type: "string", description: "Stable knowledge page refId." },
      relativePath: { type: "string", description: "Optional child file or folder path inside a collected folder." },
      maxLength: { type: "number", description: "Optional maximum text length per read from 1 to 1000000. Defaults to 30000." },
      continuation: { type: "string", description: "Opaque continuation offset returned by a previous read of the same page." },
    }, ["refId"]),
    execute: async (input) => {
      const record = asRecord(input);
      const refId = stringOrUndefined(record.refId);
      const relativePath = record.relativePath === undefined ? undefined : stringOrUndefined(record.relativePath);
      const maxLength = optionalInteger(record.maxLength);
      const continuation = record.continuation === undefined ? undefined : stringOrUndefined(record.continuation);
      if (refId === undefined || (record.relativePath !== undefined && relativePath === undefined) || maxLength === null
        || (record.continuation !== undefined && continuation === undefined)) {
        return invalid("refId is required; relativePath, maxLength and continuation must be omitted or valid values.");
      }
      return resultFor(
        () => options.knowledge.queries.readPage({
          refId,
          ...(relativePath === undefined ? {} : { relativePath }),
          ...(maxLength === undefined ? {} : { maxLength }),
          ...(continuation === undefined ? {} : { continuation }),
        }),
        (result) => result,
      );
    },
  });
}

export function createKnowledgeUpdateAssetTextTool(options: PersonalKnowledgeToolOptions): ToolExecutor {
  return tool({
    name: "KnowledgeUpdateAssetText",
    description: "Update the UTF-8 text of a managed knowledge asset using the fingerprint returned by KnowledgeReadPage. A stale fingerprint is rejected and never silently overwrites newer content. Directories, binary files and uneditable content are rejected.",
    metadata: writeMetadata,
    inputSchema: schema({
      refId: { type: "string", description: "Stable knowledge page refId of a managed asset." },
      relativePath: { type: "string", description: "Optional child file path inside a collected folder; defaults to the collected root." },
      expectedFingerprint: { type: "string", description: "Current file fingerprint returned by KnowledgeReadPage." },
      text: { type: "string", description: "New UTF-8 text content." },
    }, ["refId", "expectedFingerprint", "text"]),
    execute: async (input, context) => {
      const record = asRecord(input);
      const refId = stringOrUndefined(record.refId);
      const relativePath = record.relativePath === undefined ? undefined : stringOrUndefined(record.relativePath);
      const expectedFingerprint = stringOrUndefined(record.expectedFingerprint);
      const text = stringOrUndefined(record.text);
      if (refId === undefined || expectedFingerprint === undefined || text === undefined
        || (record.relativePath !== undefined && relativePath === undefined)) {
        return invalid("refId, expectedFingerprint and text are required; relativePath must be omitted or a string.");
      }
      return resultFor(
        () => options.knowledge.commands.updateManagedAssetText({
          refId,
          relativePath: relativePath ?? "",
          expectedFingerprint,
          text,
          actor: agentActor(context),
        }),
        (updated) => ({
          status: "updated",
          refId,
          relativePath: relativePath ?? "",
          fingerprint: updated.writeResult.fingerprint ?? null,
        }),
      );
    },
  });
}

export function createKnowledgeUncollectTool(options: PersonalKnowledgeToolOptions): ToolExecutor {
  return tool({
    name: "KnowledgeUncollect",
    description: "Explicitly uncollect a knowledge page, deleting its managed knowledge copy. This is destructive: the page and its copied content are removed and cannot be restored.",
    metadata: destructiveMetadata,
    inputSchema: schema({
      refId: { type: "string", description: "Stable knowledge page refId to uncollect." },
    }, ["refId"]),
    execute: async (input, context) => {
      const record = asRecord(input);
      const refId = stringOrUndefined(record.refId);
      if (refId === undefined) return invalid("refId is required.");
      return resultFor(
        () => options.knowledge.commands.uncollect(refId, agentActor(context)),
        (result) => ({ status: "uncollected", refId, managedCopyRemoved: result.managedCopyRemoved }),
      );
    },
  });
}

export function createKnowledgeCreateThemeTool(options: PersonalKnowledgeToolOptions): ToolExecutor {
  return tool({
    name: "KnowledgeCreateTheme",
    description: "Create a global Personal Knowledge theme. The color is chosen by the system, not by the model. A theme whose normalized name already exists is returned as-is instead of creating a duplicate.",
    metadata: writeMetadata,
    inputSchema: schema({
      name: { type: "string", description: "Theme name." },
    }, ["name"]),
    execute: async (input, context) => {
      const record = asRecord(input);
      const name = stringOrUndefined(record.name);
      if (name === undefined) return invalid("name is required.");
      return resultFor(
        () => options.knowledge.commands.createTheme({ name, actor: agentActor(context) }),
        (result) => ({ status: result.created ? "created" : "exists", theme: result.theme }),
      );
    },
  });
}

export function createKnowledgeAssignThemeTool(options: PersonalKnowledgeToolOptions): ToolExecutor {
  return tool({
    name: "KnowledgeAssignTheme",
    description: "Assign one or more knowledge pages to an existing theme in one atomic batch. Already-assigned pages are reported as unchanged; any invalid refId or themeId rejects the whole batch.",
    metadata: writeMetadata,
    inputSchema: schema({
      themeId: { type: "string", description: "Existing theme id from KnowledgeList." },
      refIds: { type: "array", items: { type: "string" }, description: "Knowledge page refIds to assign." },
    }, ["themeId", "refIds"]),
    execute: async (input, context) => {
      const record = asRecord(input);
      const themeId = stringOrUndefined(record.themeId);
      const refIds = optionalStringArray(record.refIds);
      if (themeId === undefined || refIds === null || refIds === undefined || refIds.length === 0) {
        return invalid("themeId and a non-empty refIds array are required.");
      }
      return resultFor(
        () => options.knowledge.commands.assignTheme({ themeId, refIds, actor: agentActor(context) }),
        (result) => ({ status: "assigned", themeId, assigned: result.assigned, unchanged: result.unchanged }),
      );
    },
  });
}

export function createKnowledgeUnassignThemeTool(options: PersonalKnowledgeToolOptions): ToolExecutor {
  return tool({
    name: "KnowledgeUnassignTheme",
    description: "Remove one or more knowledge pages from a theme. User-locked assignments cannot be removed by the Agent and are reported as locked; the rest are removed in one atomic batch. There is no Agent tool to lock or unlock assignments.",
    metadata: writeMetadata,
    inputSchema: schema({
      themeId: { type: "string", description: "Existing theme id from KnowledgeList." },
      refIds: { type: "array", items: { type: "string" }, description: "Knowledge page refIds to unassign." },
    }, ["themeId", "refIds"]),
    execute: async (input, context) => {
      const record = asRecord(input);
      const themeId = stringOrUndefined(record.themeId);
      const refIds = optionalStringArray(record.refIds);
      if (themeId === undefined || refIds === null || refIds === undefined || refIds.length === 0) {
        return invalid("themeId and a non-empty refIds array are required.");
      }
      return resultFor(
        () => options.knowledge.commands.unassignTheme({ themeId, refIds, actor: agentActor(context) }),
        (result) => ({ status: "unassigned", themeId, unassigned: result.unassigned, locked: result.locked }),
      );
    },
  });
}

type ToolSpec = {
  readonly name: string;
  readonly description: string;
  readonly metadata: NonNullable<ToolDefinition["metadata"]>;
  readonly inputSchema: ToolDefinition["inputSchema"];
  readonly execute: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
};

function tool(spec: ToolSpec): ToolExecutor {
  return {
    definition: {
      name: spec.name,
      description: spec.description,
      metadata: spec.metadata,
      inputSchema: spec.inputSchema,
    },
    execute: (input: unknown, context: ToolExecutionContext) => spec.execute(input, context),
  };
}

const readMetadata = { category: "workspace", riskLevel: "low", operationType: "read-only", requiresConfirmation: false } as const;
const writeMetadata = { category: "workspace", riskLevel: "low", operationType: "read-write", requiresConfirmation: false } as const;
const destructiveMetadata = { category: "workspace", riskLevel: "high", operationType: "read-write", requiresConfirmation: true, fileOperation: "delete" } as const;

function agentActor(context: ToolExecutionContext) {
  return {
    kind: "agent" as const,
    actorId: context.callerAgentId,
    traceId: context.traceId,
    goalId: context.goalId,
    ...(context.providerCallId === undefined ? {} : { toolCallId: context.providerCallId }),
  };
}

function schema(
  properties: ToolDefinition["inputSchema"]["properties"],
  required: readonly string[],
): ToolDefinition["inputSchema"] {
  return { type: "object", properties, required, additionalProperties: false };
}

function invalid(message: string) { return { status: "invalid_input", message }; }
function optionalString(value: unknown): string | undefined | null { return value === undefined ? undefined : stringOrUndefined(value) ?? null; }
function integer(value: unknown): number | undefined {
  const parsed = numberOrUndefined(value);
  return parsed !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function optionalInteger(value: unknown): number | undefined | null {
  return value === undefined ? undefined : integer(value) ?? null;
}
function optionalStringArray(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return null;
  return value;
}
function knowledgePageKind(value: unknown): "note" | "space_reference" | undefined {
  return value === "note" || value === "space_reference" ? value : undefined;
}

function knowledgeListKind(value: unknown): "note" | "space_reference" | undefined | null {
  // 省略时表示不过滤（undefined），传入非法值才是无效输入（null）。
  if (value === undefined) return undefined;
  return value === "note" || value === "space_reference" ? value : null;
}

async function resultFor<T>(operation: () => Promise<T>, project: (value: T) => unknown): Promise<unknown> {
  try {
    return project(await operation());
  } catch (error) {
    if (error instanceof PersonalKnowledgeError && isExpectedKnowledgeOperationError(error.code)) {
      return { status: error.code, message: error.message };
    }
    throw error;
  }
}

function isExpectedKnowledgeOperationError(code: PersonalKnowledgeError["code"]): boolean {
  return code === "personal_knowledge_invalid_input"
    || code === "personal_note_not_found"
    || code === "personal_note_revision_conflict"
    || code === "knowledge_theme_not_found"
    || code === "knowledge_asset_not_found"
    || code === "knowledge_asset_revision_conflict"
    || code === "knowledge_asset_source_missing"
    || code === "knowledge_asset_not_editable"
    || code === "knowledge_asset_write_failed";
}
