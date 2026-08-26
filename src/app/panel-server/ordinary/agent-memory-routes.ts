import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ConversationOwner } from "../../../domain/execution-scope/index.js";
import { memoryOwnerKey, memoryOwnersForConversation, type MemoryOwner } from "../../../domain/memory/index.js";
import {
  AgentNotesError,
  type AgentNotesFeature,
  type AgentNoteScope,
  type AgentNoteVersion,
} from "../../agent-notes/index.js";
import {
  PathDependencyFeatureError,
  type PathDependencyFeature,
  type PathDependency,
} from "../../path-dependencies/index.js";
import type { OrdinaryAgentFeature, OrdinaryMemoryFact } from "../../ordinary-agent/index.js";
import type { SpaceFeature } from "../../spaces/index.js";
import type { WorkspaceFeature } from "../../workspaces/index.js";
import type {
  SpaceConversationDeletionCoordinator,
  WorkspaceDeletionCoordinator,
} from "../../workbench-coordination/index.js";
import { PanelHttpError, readJsonBody, writeJson } from "../http-utils.js";
import type {
  DeletedMemoryHistory,
  MemorySnapshotResponse,
  PathDependency as PanelPathDependency,
  PathDependencyResponse,
} from "../../panel-api/memory.js";

export type AgentMemoryRouteDependencies = {
  readonly pathDependencyFeature: {
    readonly commands: Pick<PathDependencyFeature["commands"], "save" | "delete">;
    readonly queries: Pick<PathDependencyFeature["queries"], "get" | "list">;
  };
  readonly agentNotesFeature: {
    readonly commands: Pick<AgentNotesFeature["commands"], "write" | "delete">;
    readonly queries: Pick<AgentNotesFeature["queries"], "get">;
  };
  readonly ordinaryAgentFeature: {
    readonly queries: Pick<OrdinaryAgentFeature["queries"], "getConversationOwner" | "listMemoryFacts">;
  };
  readonly spaceFeature: {
    readonly queries: Pick<SpaceFeature["queries"], "getTree" | "list">;
  };
  readonly workspaceFeature: {
    readonly queries: Pick<WorkspaceFeature["queries"], "get" | "list">;
  };
  readonly spaceConversationDeletion: Pick<SpaceConversationDeletionCoordinator, "assertAvailable" | "isDeleting" | "admit">;
  readonly workspaceDeletion: Pick<WorkspaceDeletionCoordinator, "assertAvailable" | "isDeleting" | "admit">;
};

const id = z.string().trim().min(1).max(512);
const version = z.string().regex(/^sha256:[a-f0-9]{64}$/u).transform((value) => value as AgentNoteVersion);
const ownerKind = z.enum(["space", "workspace"]);
const noteWriteSchema = z.object({
  conversationId: id.optional(),
  ownerKind: ownerKind.optional(),
  ownerId: id.optional(),
  content: z.string().max(20_000),
  expectedVersion: version,
}).strict();
const noteDeleteSchema = z.object({
  conversationId: id.optional(),
  ownerKind: ownerKind.optional(),
  ownerId: id.optional(),
  expectedVersion: version,
}).strict();
const pathDependencySaveSchema = z.object({
  conversationId: id.optional(),
  ownerKind: ownerKind.optional(),
  ownerId: id.optional(),
  scope: z.enum(["global", "owner"]),
  memoryId: id.optional(),
  expectedRevision: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(240),
  methodology: z.string().trim().min(1).max(50_000),
  tags: z.array(z.string().trim().min(1).max(80)).max(24).optional(),
  verification: z.object({
    status: z.enum(["not_recorded", "observed"]),
  }).strict().optional(),
  evidenceRefs: z.array(id).max(64).optional(),
}).strict();
const pathDependencyDeleteSchema = z.object({
  conversationId: id.optional(),
  ownerKind: ownerKind.optional(),
  ownerId: id.optional(),
  expectedRevision: z.number().int().positive(),
}).strict();

type MemoryContextRequest = {
  readonly conversationId?: string;
  readonly ownerKind?: ConversationOwner["kind"];
  readonly ownerId?: string;
};

type MemoryContext = {
  readonly conversationId?: string;
  readonly owner?: ConversationOwner;
  readonly owners: readonly MemoryOwner[];
};

/**
 * Memory Center is a composition adapter. It can resolve a non-global scope
 * from a selected Conversation or from a registered owner choice, but an id
 * from the browser never becomes an authorization decision by itself.
 */
export async function handlePanelAgentMemoryRoute(
  runtime: AgentMemoryRouteDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/memory")) return false;

  if (request.method === "GET" && url.pathname === "/api/memory") {
    const context = await resolveMemoryContext(runtime, memoryContextFromQuery(url.searchParams));
    const payload = { ok: true, ...(await memorySnapshot(runtime, context)) } satisfies MemorySnapshotResponse;
    writeJson(response, 200, payload);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/memory/path-dependencies") {
    const context = await resolveMemoryContext(runtime, memoryContextFromQuery(url.searchParams));
    writeJson(response, 200, {
      ok: true,
      owner: context.owner ?? null,
      pathDependencies: await pathDependencyList(runtime, context),
    });
    return true;
  }

  const dependencyMatch = /^\/api\/memory\/path-dependencies\/([^/]+)$/u.exec(url.pathname);
  if (dependencyMatch !== null) {
    const memoryId = decodeURIComponent(dependencyMatch[1] ?? "");
    const context = request.method === "GET"
      ? await resolveMemoryContext(runtime, memoryContextFromQuery(url.searchParams))
      : undefined;
    if (request.method === "GET") {
      if (context === undefined) throw invalidInput("Memory scope is required.");
      const dependency = await runtime.pathDependencyFeature.queries.get(memoryId);
      if (dependency === undefined || !isVisible(context.owners, dependency.owner)) throw notFound("path_dependency_not_found", "路径依赖已不存在或不在当前作用域。");
      const payload = {
        ok: true,
        dependency: projectDependency(dependency, await factsFor(runtime, memoryId)),
      } satisfies PathDependencyResponse;
      writeJson(response, 200, payload);
      return true;
    }
    if (request.method === "DELETE") {
      const input = parse(pathDependencyDeleteSchema, await readJsonBody(request), "invalid_memory_input");
      const deleteContext = await resolveMemoryContext(runtime, input);
      const current = await runtime.pathDependencyFeature.queries.get(memoryId);
      if (current === undefined || !isVisible(deleteContext.owners, current.owner)) throw notFound("path_dependency_not_found", "路径依赖已不存在或不在当前作用域。");
      await withMemoryOwnerAdmission(runtime, current.owner, () =>
        runtime.pathDependencyFeature.commands.delete({ memoryId, expectedRevision: input.expectedRevision }));
      writeJson(response, 200, { ok: true, deleted: true, memoryId, revision: input.expectedRevision });
      return true;
    }
    if (request.method === "PATCH") {
      const input = parse(pathDependencySaveSchema, await readJsonBody(request), "invalid_memory_input");
      if (input.memoryId !== undefined && input.memoryId !== memoryId) throw invalidInput("memoryId must match the path id.");
      const result = await savePathDependency(runtime, input, memoryId);
      writeJson(response, result.status === "created" ? 201 : 200, { ok: true, result });
      return true;
    }
  }

  const noteMatch = /^\/api\/memory\/notes\/(global|owner)$/u.exec(url.pathname);
  if (noteMatch !== null) {
    const scopeKind = noteMatch[1] === "global" ? "global" : "owner";
    if (request.method === "PUT") {
      const input = parse(noteWriteSchema, await readJsonBody(request), "invalid_memory_input");
      const context = await resolveMemoryContext(runtime, input);
      const scope = noteScope(scopeKind, context);
      const result = await withMemoryOwnerAdmission(runtime, scope, () =>
        runtime.agentNotesFeature.commands.write({
          scope,
          content: input.content,
          expectedVersion: input.expectedVersion,
        }));
      if (result.status === "conflict") throw new PanelHttpError(409, "memory_note_revision_conflict", "记忆笔记已被其他操作更新，请合并后重试。");
      writeJson(response, 200, { ok: true, notebook: result.notebook });
      return true;
    }
    if (request.method === "DELETE") {
      const input = parse(noteDeleteSchema, await readJsonBody(request), "invalid_memory_input");
      const context = await resolveMemoryContext(runtime, input);
      const scope = noteScope(scopeKind, context);
      const result = await withMemoryOwnerAdmission(runtime, scope, () =>
        runtime.agentNotesFeature.commands.delete({ scope, expectedVersion: input.expectedVersion }));
      if (result.status === "conflict") throw new PanelHttpError(409, "memory_note_revision_conflict", "记忆笔记已被其他操作更新，请重新读取后确认删除。");
      writeJson(response, 200, { ok: true, deleted: true, notebook: result.notebook });
      return true;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/memory/path-dependencies") {
    const input = parse(pathDependencySaveSchema, await readJsonBody(request), "invalid_memory_input");
    const result = await savePathDependency(runtime, input);
    writeJson(response, result.status === "created" ? 201 : 200, { ok: true, result });
    return true;
  }

  return false;
}

async function savePathDependency(
  runtime: AgentMemoryRouteDependencies,
  input: z.infer<typeof pathDependencySaveSchema>,
  routeMemoryId?: string,
) {
  const context = await resolveMemoryContext(runtime, input);
  const memoryId = routeMemoryId ?? input.memoryId;
  if (routeMemoryId !== undefined) {
    const current = await runtime.pathDependencyFeature.queries.get(routeMemoryId);
    if (current === undefined || !isVisible(context.owners, current.owner)) throw notFound("path_dependency_not_found", "路径依赖已不存在或不在当前作用域。");
  }
  const owner = input.scope === "global" ? ({ kind: "global" } as const) : requireOwner(context);
  if (memoryId !== undefined && input.expectedRevision === undefined) {
    throw invalidInput("Updating a path dependency requires expectedRevision.");
  }
  const result = await withMemoryOwnerAdmission(runtime, owner, () =>
    runtime.pathDependencyFeature.commands.save({
      owner,
      ...(memoryId === undefined ? {} : { memoryId }),
      title: input.title,
      methodology: input.methodology,
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      ...(input.evidenceRefs === undefined ? {} : { evidenceRefs: input.evidenceRefs }),
      ...(input.verification === undefined ? {} : { verification: input.verification }),
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      createdBy: "user",
    }));
  if (result.status === "conflict") throw new PanelHttpError(409, "path_dependency_revision_conflict", "路径依赖已被更新，请重新读取后合并。");
  return result;
}

async function resolveMemoryContext(runtime: AgentMemoryRouteDependencies, request: MemoryContextRequest): Promise<MemoryContext> {
  const hasOwnerKind = request.ownerKind !== undefined;
  const hasOwnerId = request.ownerId !== undefined;
  if (hasOwnerKind !== hasOwnerId) throw invalidInput("ownerKind and ownerId must be provided together.");
  if (request.conversationId !== undefined && hasOwnerKind) {
    throw invalidInput("conversationId cannot be combined with an explicit memory owner.");
  }
  if (request.ownerKind !== undefined && request.ownerId !== undefined) {
    const owner = await resolveSelectedOwner(runtime, { kind: request.ownerKind, id: request.ownerId });
    return { owner, owners: memoryOwnersForConversation(owner) };
  }
  if (request.conversationId === undefined) return { owners: [{ kind: "global" }] };
  const owner = await runtime.ordinaryAgentFeature.queries.getConversationOwner(request.conversationId);
  if (owner === undefined) throw notFound("conversation_not_found", "对话不存在或没有稳定 owner。");
  // A conversation id is only a lookup key, not an authorization bypass. The
  // selected owner must pass the same deletion/existence gate as an explicit
  // Space or Workspace selection, including after a process restart.
  const availableOwner = await resolveSelectedOwner(runtime, owner);
  return { conversationId: request.conversationId, owner: availableOwner, owners: memoryOwnersForConversation(availableOwner) };
}

async function memorySnapshot(
  runtime: AgentMemoryRouteDependencies,
  context: MemoryContext,
): Promise<Omit<MemorySnapshotResponse, "ok">> {
  const [globalNote, ownerNote, pathDependencies, facts, owners] = await Promise.all([
    runtime.agentNotesFeature.queries.get({ kind: "global" }),
    context.owner === undefined ? Promise.resolve(undefined) : runtime.agentNotesFeature.queries.get(context.owner),
    pathDependencyList(runtime, context),
    runtime.ordinaryAgentFeature.queries.listMemoryFacts(),
    memoryOwnerOptions(runtime),
  ]);
  const visibleFacts = facts.filter((fact) => isVisible(context.owners, fact.owner));
  return {
    conversationId: context.conversationId,
    owner: context.owner ?? null,
    owners,
    scopes: context.owners,
    globalNote,
    ownerNote,
    notes: { global: globalNote, owner: ownerNote },
    pathDependencies,
    history: deletedDependencyHistory(pathDependencies, visibleFacts),
  };
}

async function resolveSelectedOwner(
  runtime: AgentMemoryRouteDependencies,
  owner: Exclude<MemoryOwner, { readonly kind: "global" }>,
): Promise<ConversationOwner> {
  if (owner.kind === "space") {
    runtime.spaceConversationDeletion.assertAvailable(owner.id);
    if (await runtime.spaceFeature.queries.getTree(owner.id) === undefined) {
      throw notFound("space_not_found", "空间不存在或已删除。");
    }
    return owner;
  }
  runtime.workspaceDeletion.assertAvailable(owner.id);
  const workspace = await runtime.workspaceFeature.queries.get(owner.id);
  if (workspace === undefined || workspace.status === "deleting") {
    throw notFound("workspace_not_found", "工作区不存在或已删除。");
  }
  return owner;
}

async function memoryOwnerOptions(runtime: AgentMemoryRouteDependencies): Promise<readonly MemoryOwner[]> {
  const [spaces, workspaces] = await Promise.all([
    runtime.spaceFeature.queries.list(),
    runtime.workspaceFeature.queries.list(),
  ]);
  return [
    { kind: "global" as const },
    ...spaces
      .filter((space) => !runtime.spaceConversationDeletion.isDeleting(space.id))
      .map((space) => ({ kind: "space" as const, id: space.id, title: space.title })),
    ...workspaces
      .filter((workspace) => workspace.status !== "deleting" && !runtime.workspaceDeletion.isDeleting(workspace.id))
      .map((workspace) => ({ kind: "workspace" as const, id: workspace.id, title: workspace.title })),
  ];
}

async function pathDependencyList(runtime: AgentMemoryRouteDependencies, context: MemoryContext) {
  const dependencies = await runtime.pathDependencyFeature.queries.list({ owners: context.owners });
  const facts = await runtime.ordinaryAgentFeature.queries.listMemoryFacts();
  const visibleFacts = facts.filter((fact) => isVisible(context.owners, fact.owner));
  return dependencies.map((dependency) => projectDependency(dependency, visibleFacts.filter((fact) => fact.memoryId === dependency.id)));
}

function projectDependency(dependency: PathDependency, facts: readonly OrdinaryMemoryFact[]): PanelPathDependency {
  const dependencyFacts = facts.filter((fact) =>
    fact.memoryId === dependency.id && memoryOwnerKey(fact.owner) === memoryOwnerKey(dependency.owner));
  return {
    id: dependency.id,
    kind: "path_dependency" as const,
    owner: dependency.owner,
    title: dependency.title,
    methodology: dependency.methodology,
    excerpt: dependency.methodology.slice(0, 240),
    sourceRunRefs: dependency.sourceRunRefs,
    verification: dependency.verification,
    evidenceRefs: dependency.evidenceRefs,
    revision: dependency.revision,
    contentVersion: dependency.contentVersion,
    createdAt: dependency.createdAt,
    updatedAt: dependency.updatedAt,
    createdBy: dependency.createdBy,
    tags: dependency.tags,
    sourceRunCount: dependency.sourceRunRefs.length,
    evidenceCount: dependency.evidenceRefs.length,
    readCount: dependencyFacts.filter((fact) => fact.kind === "read").length,
    useCount: dependencyFacts.filter((fact) => fact.kind === "applied").length,
    references: dependencyFacts.map((fact) => ({
      factId: fact.factId,
      kind: fact.kind,
      runId: fact.runId,
      conversationId: fact.conversationId,
      revision: fact.revision,
      title: fact.title,
      recordedAt: fact.recordedAt,
      note: fact.note,
    })),
  };
}

function deletedDependencyHistory(
  current: readonly ReturnType<typeof projectDependency>[],
  facts: readonly OrdinaryMemoryFact[],
): readonly DeletedMemoryHistory[] {
  const currentKeys = new Set(current.map((dependency) => `${dependency.id}|${memoryOwnerKey(dependency.owner)}`));
  const grouped = new Map<string, OrdinaryMemoryFact[]>();
  for (const fact of facts) {
    const key = `${fact.memoryId}|${memoryOwnerKey(fact.owner)}`;
    if (currentKeys.has(key)) continue;
    const entries = grouped.get(key) ?? [];
    entries.push(fact);
    grouped.set(key, entries);
  }
  return [...grouped.entries()].map(([key, entries]) => {
    const latest = [...entries].sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0]!;
    return {
      id: latest.memoryId,
      historyKey: key,
      kind: "path_dependency" as const,
      owner: latest.owner,
      title: latest.title,
      revision: latest.revision,
      available: false,
      readCount: entries.filter((fact) => fact.kind === "read").length,
      useCount: entries.filter((fact) => fact.kind === "applied").length,
      references: entries.map((fact) => ({
        factId: fact.factId,
        kind: fact.kind,
        runId: fact.runId,
        conversationId: fact.conversationId,
        revision: fact.revision,
        title: fact.title,
        recordedAt: fact.recordedAt,
        note: fact.note,
      })),
    };
  });
}

async function factsFor(runtime: AgentMemoryRouteDependencies, memoryId: string): Promise<readonly OrdinaryMemoryFact[]> {
  return runtime.ordinaryAgentFeature.queries.listMemoryFacts({ memoryId });
}

function noteScope(kind: "global" | "owner", context: MemoryContext): AgentNoteScope {
  return kind === "global" ? { kind: "global" } : requireOwner(context);
}

function requireOwner(context: MemoryContext): Exclude<MemoryOwner, { readonly kind: "global" }> {
  if (context.owner === undefined) throw new PanelHttpError(400, "memory_owner_required", "当前操作需要先打开一个有稳定 owner 的对话。");
  return context.owner;
}

/**
 * Owner-scoped memory mutations share the lifecycle admission gate with run
 * birth and owner deletion. A one-time `assertAvailable` is not enough: a
 * deletion can begin between that check and the filesystem/SQLite write.
 */
async function withMemoryOwnerAdmission<T>(
  runtime: AgentMemoryRouteDependencies,
  owner: MemoryOwner,
  operation: () => Promise<T>,
): Promise<T> {
  if (owner.kind === "global") return operation();
  if (owner.kind === "space") return runtime.spaceConversationDeletion.admit(owner.id, operation);
  return runtime.workspaceDeletion.admit(owner.id, operation);
}

function isVisible(owners: readonly MemoryOwner[], owner: MemoryOwner): boolean {
  const key = memoryOwnerKey(owner);
  return owners.some((candidate) => memoryOwnerKey(candidate) === key);
}

function optionalConversationId(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value.trim().length === 0 ? undefined : value.trim();
}

function memoryContextFromQuery(searchParams: URLSearchParams): MemoryContextRequest {
  const conversationId = optionalConversationId(searchParams.get("conversationId"));
  const rawKind = optionalConversationId(searchParams.get("ownerKind"));
  const ownerId = optionalConversationId(searchParams.get("ownerId"));
  if (rawKind !== undefined && rawKind !== "space" && rawKind !== "workspace") {
    throw invalidInput("ownerKind must be space or workspace.");
  }
  return {
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(rawKind === undefined ? {} : { ownerKind: rawKind }),
    ...(ownerId === undefined ? {} : { ownerId }),
  };
}

function parse<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalidInput(code);
  return result.data;
}

function invalidInput(message = "记忆请求数据无效。"): PanelHttpError {
  return new PanelHttpError(400, "invalid_memory_input", message);
}

function notFound(code: string, message: string): PanelHttpError {
  return new PanelHttpError(404, code, message);
}

export function agentMemoryHttpError(error: AgentNotesError | PathDependencyFeatureError): PanelHttpError {
  if (error instanceof AgentNotesError) {
    if (error.code === "note_too_large") return new PanelHttpError(400, error.code, error.message);
    if (error.code === "note_owner_deleted") return new PanelHttpError(409, error.code, error.message);
    return new PanelHttpError(500, error.code, error.message);
  }
  switch (error.code) {
    case "path_dependency_feature_released":
      return new PanelHttpError(503, "panel_runtime_quiescing", error.message);
    case "path_dependency_invalid_input":
      return new PanelHttpError(400, error.code, error.message);
    case "path_dependency_not_found":
      return new PanelHttpError(404, error.code, error.message);
    case "path_dependency_revision_conflict":
    case "path_dependency_owner_deleted":
      return new PanelHttpError(409, error.code, error.message);
    case "path_dependency_snapshot_incompatible":
    case "path_dependency_repository_failure":
      return new PanelHttpError(500, error.code, error.message);
  }
}
