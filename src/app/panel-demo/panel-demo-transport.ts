import type { Conversation } from "../panel-ui/src/contracts/conversation";
import type { DocumentPreview } from "@panel-api/workbench";
import {
  createDemoConversation,
  createDemoKnowledgeSnapshot,
  demoConfig,
  demoSkills,
  demoSubAgents,
  demoTools,
  demoUsageStatistics,
  getDemoKnowledgePreview,
  getDemoSpacePreview,
  getDemoSpaceTree,
  listDemoSpaces,
  summarizeDemoConversation,
  type DemoKnowledgeSnapshot,
} from "./panel-demo-fixture";

type DemoState = {
  knowledge: DemoKnowledgeSnapshot;
  conversations: Map<string, Conversation>;
  runViews: Map<string, NonNullable<Conversation["currentRun"]>>;
  previewOverrides: Map<string, DocumentPreview>;
};

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

export function installPanelDemoTransport(): void {
  const nativeFetch = window.fetch.bind(window);
  const state: DemoState = {
    knowledge: createDemoKnowledgeSnapshot(),
    conversations: new Map(),
    runViews: new Map(),
    previewOverrides: new Map(),
  };

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) {
      return nativeFetch(input, init);
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = await readRequestBody(input, init);
    return routeDemoRequest(state, url, method, body);
  }) as typeof window.fetch;

  window.EventSource = DemoEventSource as unknown as typeof EventSource;
}

async function routeDemoRequest(
  state: DemoState,
  url: URL,
  method: string,
  bodyText: string,
): Promise<Response> {
  const path = url.pathname;
  const body = parseBody(bodyText);

  if (method === "GET" && path === "/api/config") return json(demoConfig);
  if (method === "GET" && path === "/api/config/tools") return json(demoTools);
  if (method === "GET" && path === "/api/config/mcp") return json({ ok: true, status: "completed", catalog: [] });
  if (method === "GET" && path === "/api/skills") return json({ ok: true, skills: demoSkills });
  if (method === "GET" && path === "/api/config/sub-agents") return json({ ok: true, status: "completed", subAgents: demoSubAgents });
  if (method === "GET" && path === "/api/workspaces") return json({ ok: true, workspaces: [] });
  if (method === "GET" && path === "/api/runtime/usage-statistics") return json(demoUsageStatistics());

  if (method === "GET" && path === "/api/spaces") {
    return json({ ok: true, spaces: listDemoSpaces() });
  }
  const spaceId = matchPath(path, /^\/api\/spaces\/([^/]+)$/u);
  if (method === "GET" && spaceId !== undefined) {
    const tree = getDemoSpaceTree(spaceId);
    if (tree === undefined) return missing("space_not_found", "空间不存在。");
    const conversations = [...state.conversations.values()]
      .filter((conversation) => conversation.owner?.kind === "space" && conversation.owner.id === spaceId)
      .map(summarizeDemoConversation);
    return json({ ok: true, tree, conversations });
  }

  if (method === "GET" && path === "/api/conversations") {
    return json({ ok: true, conversations: [...state.conversations.values()].map(summarizeDemoConversation) });
  }
  if (method === "POST" && path === "/api/conversations") {
    const goal = bodyString(body, "goal");
    if (goal.length === 0) return invalid("goal_required", "请输入任务内容。");
    const owner = conversationOwner(body.owner);
    const created = createDemoConversation(goal, owner);
    state.conversations.set(created.conversation.conversationId, created.conversation);
    state.runViews.set(created.runView.run.runId, created.runView);
    return json({ ok: true, conversation: created.conversation, run: created.runView.run }, 201);
  }
  const conversationId = matchPath(path, /^\/api\/conversations\/([^/]+)$/u);
  if (conversationId !== undefined) {
    const conversation = state.conversations.get(conversationId);
    if (conversation === undefined) return missing("conversation_not_found", "会话不存在。");
    if (method === "GET") return json({ ok: true, conversation });
    if (method === "DELETE") {
      state.conversations.delete(conversationId);
      return json({ ok: true, conversationId });
    }
  }
  const messageConversationId = matchPath(path, /^\/api\/conversations\/([^/]+)\/messages$/u);
  if (method === "POST" && messageConversationId !== undefined) {
    const previous = state.conversations.get(messageConversationId);
    if (previous === undefined) return missing("conversation_not_found", "会话不存在。");
    const goal = bodyString(body, "goal");
    if (goal.length === 0) return invalid("goal_required", "请输入任务内容。");
    const created = createDemoConversation(goal, previous.owner, previous);
    state.conversations.set(messageConversationId, created.conversation);
    state.runViews.set(created.runView.run.runId, created.runView);
    return json({ ok: true, conversation: created.conversation, run: created.runView.run });
  }
  const renameConversationId = matchPath(path, /^\/api\/conversations\/([^/]+)\/rename$/u);
  if (method === "POST" && renameConversationId !== undefined) {
    const previous = state.conversations.get(renameConversationId);
    if (previous === undefined) return missing("conversation_not_found", "会话不存在。");
    const title = bodyString(body, "title").trim();
    const conversation = { ...previous, title: title || previous.title, titleEditedAt: new Date().toISOString() };
    state.conversations.set(renameConversationId, conversation);
    return json({ ok: true, conversation });
  }
  const pinConversationId = matchPath(path, /^\/api\/conversations\/([^/]+)\/pin$/u);
  if (method === "POST" && pinConversationId !== undefined) {
    const previous = state.conversations.get(pinConversationId);
    if (previous === undefined) return missing("conversation_not_found", "会话不存在。");
    const conversation = { ...previous, pinnedAt: body.pinned === false ? undefined : new Date().toISOString() };
    state.conversations.set(pinConversationId, conversation);
    return json({ ok: true, conversation });
  }

  const branchSelectionId = matchPath(path, /^\/api\/conversations\/([^/]+)\/branches\/select$/u);
  if (method === "POST" && branchSelectionId !== undefined) {
    const previous = state.conversations.get(branchSelectionId);
    if (previous === undefined) return missing("conversation_not_found", "会话不存在。");
    const targetRunId = bodyString(body, "targetRunId");
    if (targetRunId.length === 0 || !state.runViews.has(targetRunId)) return missing("run_not_found", "消息版本不存在。");
    const conversation = { ...previous, latestRunId: targetRunId, activeRunId: targetRunId };
    state.conversations.set(branchSelectionId, conversation);
    return json({ ok: true, conversation });
  }

  // Memory管理页在 Demo 中保持可用但停用：浏览器 Demo 不提供本地记忆存储。
  if (method === "GET" && path === "/api/memory/status") {
    return json({ ok: true, status: { hasContent: false, enabled: false, rollout: "active", health: "ready", effective: "off" } });
  }
  if (method === "GET" && path === "/api/memory/document") {
    return json({ ok: true, view: { document: undefined, entries: [], topics: [], nextCursor: null, summaryCount: 0, lastMaintenanceAt: null } });
  }
  if (method === "POST" && path === "/api/memory") {
    return json({ ok: true, policyRevision: "demo-policy-1", generation: 0, revisionId: "demo-memory-revision", revision: 1 });
  }

  // 协作规则在 Demo 中是内存草稿：读取返回空规则，保存回显写入内容。
  if (method === "GET" && path === "/api/collaboration-rules") {
    const scope = url.searchParams.get("scopeKind") === "space" && url.searchParams.get("scopeId") !== null
      ? { kind: "space" as const, id: url.searchParams.get("scopeId")! }
      : { kind: "global" as const };
    return json({ ok: true, document: { scope, content: "", version: "demo-rules-1", updatedAt: undefined, source: { kind: "managed" } } });
  }
  if (method === "PUT" && path === "/api/collaboration-rules") {
    const scope = typeof body.scope === "object" && body.scope !== null
      ? body.scope as { kind: "global" } | { kind: "space"; id: string }
      : { kind: "global" as const };
    return json({ ok: true, document: { scope, content: bodyString(body, "content"), version: `demo-rules-${Date.now()}`, updatedAt: new Date().toISOString(), source: { kind: "managed" } } });
  }

  const runId = matchPath(path, /^\/api\/ordinary\/runs\/([^/]+)\/view$/u);
  if (method === "GET" && runId !== undefined) {
    const view = state.runViews.get(runId);
    return view === undefined ? missing("run_not_found", "运行不存在。") : json({ ok: true, view });
  }

  if (method === "GET" && path === "/api/personal-knowledge") {
    return json({ ok: true, snapshot: state.knowledge });
  }
  if (method === "GET" && path === "/api/personal-knowledge/search") {
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const results = state.knowledge.notes
      .filter((note) => `${note.title} ${note.bodyMarkdown}`.toLowerCase().includes(query))
      .slice(0, Number.isFinite(limit) ? limit : 50)
      .map(({ bodyMarkdown, ...note }) => ({ note, snippet: bodyMarkdown.replace(/\s+/gu, " ").slice(0, 120) }));
    return json({ ok: true, results });
  }
  if (method === "POST" && path === "/api/personal-knowledge/notes") {
    const now = Date.now();
    const note = {
      id: bodyString(body, "id") || crypto.randomUUID(),
      ...(typeof body.spaceId === "string" ? { spaceId: body.spaceId } : {}),
      title: bodyString(body, "title"),
      bodyMarkdown: bodyString(body, "bodyMarkdown"),
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    state.knowledge.notes.unshift(note);
    return json({ ok: true, note }, 201);
  }
  const noteId = matchPath(path, /^\/api\/personal-knowledge\/notes\/([^/]+)$/u);
  if (noteId !== undefined) {
    const index = state.knowledge.notes.findIndex((note) => note.id === noteId);
    if (index < 0) return missing("note_not_found", "笔记不存在。");
    const current = state.knowledge.notes[index]!;
    if (method === "GET") return json({ ok: true, note: current });
    if (method === "PATCH") {
      const note = {
        ...current,
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.bodyMarkdown === "string" ? { bodyMarkdown: body.bodyMarkdown } : {}),
        updatedAt: Date.now(),
        revision: current.revision + 1,
      };
      state.knowledge.notes[index] = note;
      return json({ ok: true, note });
    }
    if (method === "DELETE") {
      state.knowledge.notes.splice(index, 1);
      state.knowledge.pages = state.knowledge.pages.filter((page) => page.refId !== noteId);
      return json({ ok: true, noteId });
    }
  }
  const revisionNoteId = matchPath(path, /^\/api\/personal-knowledge\/notes\/([^/]+)\/revisions$/u);
  if (method === "GET" && revisionNoteId !== undefined) return json({ ok: true, revisions: [] });
  if (method === "POST" && path === "/api/personal-knowledge/notes/reorder") return json({ ok: true });
  if (method === "POST" && path === "/api/personal-knowledge/commands") return json({ ok: true });
  if (method === "POST" && path === "/api/personal-knowledge/collect-space-reference") {
    const referenceId = bodyString(body, "referenceId");
    const relativePath = bodyString(body, "relativePath");
    const sourcePreview = getDemoSpacePreview(referenceId, relativePath);
    if (sourcePreview === undefined) return missing("reference_not_found", "资料不存在。");
    const refId = `demo-collected-${crypto.randomUUID()}`;
    const page = {
      refId,
      kind: "space_reference" as const,
      collectedAt: Date.now(),
      asset: {
        status: "managed" as const,
        title: relativePath || sourcePreview.title,
        sourceLabel: sourcePreview.source,
        contentKind: "file" as const,
        sourceReferenceId: referenceId,
        sourceRelativePath: relativePath,
      },
    };
    state.knowledge.pages.unshift(page);
    return json({ ok: true, page });
  }

  const previewMatch = /^\/api\/(spaces\/references|personal-knowledge\/assets)\/([^/]+)\/preview$/u.exec(path);
  if (method === "GET" && previewMatch !== null) {
    const apiBase = previewMatch[1] === "spaces/references" ? "spaces" : "knowledge";
    const itemId = decodeURIComponent(previewMatch[2]!);
    const relativePath = url.searchParams.get("path") ?? "";
    const key = previewKey(apiBase, itemId, relativePath);
    const preview = state.previewOverrides.get(key) ?? (apiBase === "spaces"
      ? getDemoSpacePreview(itemId, relativePath)
      : getDemoKnowledgePreview(itemId));
    return preview === undefined ? missing("preview_not_found", "资料预览不存在。") : json({ ok: true, preview });
  }
  const contentMatch = /^\/api\/(spaces\/references|personal-knowledge\/assets)\/([^/]+)\/content$/u.exec(path);
  if (method === "PUT" && contentMatch !== null) {
    const apiBase = contentMatch[1] === "spaces/references" ? "spaces" : "knowledge";
    const itemId = decodeURIComponent(contentMatch[2]!);
    const relativePath = bodyString(body, "relativePath");
    const current = apiBase === "spaces" ? getDemoSpacePreview(itemId, relativePath) : getDemoKnowledgePreview(itemId);
    if (current === undefined || current.content.kind !== "text") return invalid("preview_not_editable", "此资料不能编辑。");
    const text = bodyString(body, "text");
    const preview: DocumentPreview = {
      ...current,
      fingerprint: `demo-edit:${Date.now()}`,
      byteLength: new TextEncoder().encode(text).byteLength,
      modifiedAt: Date.now(),
      content: { ...current.content, text },
    };
    state.previewOverrides.set(previewKey(apiBase, itemId, relativePath), preview);
    return json({ ok: true, preview });
  }
  const captionMatch = /^\/api\/(spaces\/references|personal-knowledge\/assets)\/([^/]+)\/caption$/u.exec(path);
  if (method === "PUT" && captionMatch !== null) {
    const apiBase = captionMatch[1] === "spaces/references" ? "spaces" : "knowledge";
    const itemId = decodeURIComponent(captionMatch[2]!);
    const relativePath = bodyString(body, "relativePath");
    const current = apiBase === "spaces" ? getDemoSpacePreview(itemId, relativePath) : getDemoKnowledgePreview(itemId);
    if (current === undefined || current.content.kind !== "media" || current.content.mediaKind !== "image") {
      return invalid("caption_not_editable", "此资料不支持图片说明。");
    }
    const preview: DocumentPreview = {
      ...current,
      content: { ...current.content, caption: bodyString(body, "caption"), captionFingerprint: `demo-caption:${Date.now()}` },
    };
    state.previewOverrides.set(previewKey(apiBase, itemId, relativePath), preview);
    return json({ ok: true, preview });
  }

  if (method === "POST" && /^\/api\/spaces\/references\/[^/]+\/open$/u.test(path)) return json({ ok: true });

  return json({
    error: {
      code: "demo_read_only",
      message: "此操作需要桌面版的本地运行时；浏览器 Demo 不会改动你的电脑。",
    },
  }, 409);
}

function previewKey(apiBase: string, itemId: string, relativePath: string): string {
  return `${apiBase}:${itemId}:${relativePath}`;
}

function conversationOwner(value: unknown): Conversation["owner"] {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { kind?: unknown; id?: unknown };
  if (candidate.kind === "space" && typeof candidate.id === "string") {
    return { kind: candidate.kind, id: candidate.id };
  }
  return undefined;
}

function parseBody(value: string): Record<string, unknown> {
  if (value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function readRequestBody(input: RequestInfo | URL, init: RequestInit | undefined): Promise<string> {
  if (typeof init?.body === "string") return init.body;
  if (input instanceof Request) return input.clone().text();
  return "";
}

function bodyString(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? body[key] : "";
}

function matchPath(path: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(path);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: jsonHeaders });
}

function missing(code: string, message: string): Response {
  return json({ error: { code, message } }, 404);
}

function invalid(code: string, message: string): Response {
  return json({ error: { code, message } }, 400);
}

class DemoEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials = false;
  readyState = DemoEventSource.CONNECTING;
  onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;

  constructor(url: string | URL) {
    super();
    this.url = new URL(String(url), window.location.href).href;
    queueMicrotask(() => {
      if (this.readyState === DemoEventSource.CLOSED) return;
      this.readyState = DemoEventSource.OPEN;
      const event = new Event("open");
      this.dispatchEvent(event);
      this.onopen?.call(this as unknown as EventSource, event);
    });
  }

  close(): void {
    this.readyState = DemoEventSource.CLOSED;
  }
}
