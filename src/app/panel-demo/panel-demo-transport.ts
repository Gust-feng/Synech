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

type DemoModelConfigState = {
  config: Record<string, unknown>;
  profiles: Record<string, unknown>[];
  modelProviderOrder: string[];
  modelCatalogs: Record<string, unknown>[];
  modelCapabilityProfiles: Record<string, unknown>[];
};

type DemoMemoryEntry = { entry: Record<string, unknown>; revisions: Record<string, unknown>[] };

type DemoMemoryState = {
  enabled: boolean;
  revisionSeq: number;
  overviewRevision: number;
  entries: DemoMemoryEntry[];
  requests: Map<string, string>;
};

type DemoState = {
  knowledge: DemoKnowledgeSnapshot;
  conversations: Map<string, Conversation>;
  runViews: Map<string, NonNullable<Conversation["currentRun"]>>;
  previewOverrides: Map<string, DocumentPreview>;
  config: DemoModelConfigState;
  memory: DemoMemoryState;
};

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

export function installPanelDemoTransport(): void {
  const nativeFetch = window.fetch.bind(window);
  const state: DemoState = {
    knowledge: createDemoKnowledgeSnapshot(),
    conversations: new Map(),
    runViews: new Map(),
    previewOverrides: new Map(),
    config: {
      config: { ...(demoConfig.config as unknown as Record<string, unknown>) },
      profiles: (demoConfig.profiles ?? []).map((p) => ({ ...(p as unknown as Record<string, unknown>) })),
      modelProviderOrder: [...(demoConfig.modelProviderOrder ?? [])],
      modelCatalogs: (demoConfig.modelCatalogs ?? []).map((c) => {
        const entry = c as unknown as Record<string, unknown>;
        return { ...entry, models: [...((entry.models as unknown[] | undefined) ?? [])] };
      }),
      modelCapabilityProfiles: (demoConfig.modelCapabilityProfiles ?? []).map((c) => ({ ...(c as unknown as Record<string, unknown>) })),
    },
    memory: { enabled: true, revisionSeq: 0, overviewRevision: 0, entries: [], requests: new Map() },
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

  if (method === "GET" && path === "/api/config") return json(currentConfigResponse(state));

  // 模型服务配置：浏览器 Demo 用内存充当临时后端，改动刷新后丢失。
  const modelConfig = handleModelConfigRequest(state, url, method, body);
  if (modelConfig !== undefined) return modelConfig;

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

  // 记忆管理：浏览器 Demo 用内存充当临时后端，条目改动刷新后丢失。
  if (path === "/api/memory/status" && method === "GET") {
    return json({ ok: true, status: {
      hasContent: state.memory.entries.length > 0, enabled: state.memory.enabled,
      rollout: "active", health: "ready", effective: state.memory.enabled ? "active" : "off",
    } });
  }
  if (path === "/api/memory/document" && method === "GET") {
    const entryId = url.searchParams.get("entryId");
    const limit = Number(url.searchParams.get("limit") ?? 0);
    let views = state.memory.entries.map(memoryEntryView);
    if (entryId !== null && entryId.length > 0) views = views.filter((v) => (v.entry as { entryId?: string }).entryId === entryId);
    views.reverse();
    return json({ ok: true, view: {
      document: memoryOverview(state), entries: limit > 0 ? views.slice(0, limit) : views,
      topics: [], nextCursor: null, summaryCount: 0, lastMaintenanceAt: null,
    } });
  }
  if (path === "/api/memory" && method === "POST") {
    const op = bodyString(body, "op");
    if (op === "setEnabled") {
      state.memory.enabled = body.enabled === true;
      return json({ ok: true, policyRevision: `demo-policy-${state.memory.revisionSeq}` });
    }
    if (op === "setRollout") return json({ ok: true, policyRevision: "demo-policy-rollout" });
    if (op === "clearMemory") {
      state.memory.entries = [];
      state.memory.overviewRevision += 1;
      return json({ ok: true, generation: 1 });
    }
    if (op === "updateMemory") {
      const edit = (body.edit ?? {}) as Record<string, unknown>;
      const requestId = bodyString(body, "requestId");
      const cached = state.memory.requests.get(requestId);
      if (cached !== undefined) return json(JSON.parse(cached) as unknown);
      const entryId = bodyString(edit, "entryId");
      const expectedRevisionId = bodyString(edit, "expectedRevisionId");
      const revisionId = `memrev-${++state.memory.revisionSeq}`;
      const kind = bodyString(edit, "kind") || "initial";
      if (edit.operation === "create") {
        if (state.memory.entries.some((e) => (e.entry as { entryId?: string }).entryId === entryId)) {
          return json({ error: { code: "memory_request_conflict", message: "该条目 id 已存在。" } }, 409);
        }
        const entry: Record<string, unknown> = {
          entryId, owner: body.owner, generation: 0, headRevisionId: revisionId, createdAt: Date.now(),
        };
        state.memory.entries.push({ entry, revisions: [memoryRevision(entryId, edit, {
          revisionId, revision: 1, previousRevisionId: null, kind,
        })] });
        state.memory.overviewRevision += 1;
        const result = { ok: true, entryId, revisionId, revision: 1, overviewRevisionId: revisionId };
        state.memory.requests.set(requestId, JSON.stringify(result));
        return json(result);
      }
      const entry = state.memory.entries.find((e) => (e.entry as { entryId?: string }).entryId === entryId);
      if (entry === undefined) return missing("memory_entry_not_found", "未找到该记忆条目。");
      const head = entry.revisions[entry.revisions.length - 1]!;
      if ((head as { revisionId?: string }).revisionId !== expectedRevisionId) {
        return json({ error: { code: "memory_revision_stale", message: "记忆条目已有更新的修订，请刷新后基于最新版本编辑。" } }, 409);
      }
      const kindValue = kind === "initial" ? "supplement" : kind;
      entry.revisions.push(memoryRevision(entryId, edit, {
        revisionId, revision: entry.revisions.length + 1, previousRevisionId: expectedRevisionId, kind: kindValue,
      }));
      (entry.entry as { headRevisionId?: unknown }).headRevisionId = revisionId;
      state.memory.overviewRevision += 1;
      const result = { ok: true, entryId, revisionId, revision: entry.revisions.length, overviewRevisionId: revisionId };
      state.memory.requests.set(requestId, JSON.stringify(result));
      return json(result);
    }
    return desktopOnly();
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

  return desktopOnly();
}

function desktopOnly(): Response {
  return json({
    error: {
      code: "demo_read_only",
      message: "浏览器 Demo 不发起网络请求、不改动本地文件；此操作仅桌面版可用。",
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

// ---------------------------------------------------------------------------
// 模型服务配置的内存后端（浏览器临时存储，刷新后丢失）
// ---------------------------------------------------------------------------

function currentConfigResponse(state: DemoState): Record<string, unknown> {
  return {
    ...demoConfig,
    config: state.config.config,
    profiles: state.config.profiles,
    modelProviderOrder: state.config.modelProviderOrder,
    modelCatalogs: state.config.modelCatalogs,
    modelCapabilityProfiles: state.config.modelCapabilityProfiles,
  };
}

function modelConfigResponse(state: DemoState, extra: Record<string, unknown> = {}): Response {
  return json({
    ok: true,
    status: "completed",
    config: state.config.config,
    profiles: state.config.profiles,
    modelProviderOrder: state.config.modelProviderOrder,
    modelCatalogs: state.config.modelCatalogs,
    modelCapabilityProfiles: state.config.modelCapabilityProfiles,
    modelProviderMarket: demoConfig.modelProviderMarket,
    capabilities: demoConfig.capabilities,
    ...extra,
  });
}

function handleModelConfigRequest(
  state: DemoState,
  url: URL,
  method: string,
  body: Record<string, unknown>,
): Response | undefined {
  const path = url.pathname;
  const profileMatch = /^\/api\/config\/model-profiles\/([^/]+)$/u.exec(path);
  const profileSubMatch = /^\/api\/config\/model-profiles\/([^/]+)\/([a-z-]+)$/u.exec(path);

  if (path === "/api/config/model-profiles" && method === "POST") {
    const profileId = bodyString(body, "profileId");
    if (profileId.length === 0) return invalid("missing_model_profile_id", "模型 profile id 不能为空。");
    if (state.config.profiles.some((p) => p.profileId === profileId)) {
      return invalid("model_profile_conflict", "该模型服务 id 已存在。");
    }
    const profile: Record<string, unknown> = {
      profileId, enabled: true, secretConfigured: false, updatedAt: new Date().toISOString(),
    };
    applyModelProfileFields(profile, body);
    state.config.profiles.push(profile);
    state.config.modelProviderOrder.push(`profile:${profileId}`);
    state.config.modelCatalogs.push({
      profileId, label: profile.label ?? profileId, baseUrl: profile.baseUrl ?? "", modelsPath: "/models", models: [],
    });
    return modelConfigResponse(state, { profile });
  }

  if (profileMatch !== null) {
    const profileId = decodeURIComponent(profileMatch[1] ?? "");
    const profile = state.config.profiles.find((p) => p.profileId === profileId);
    if (profile === undefined) return missing("model_profile_not_found", "未找到模型配置。");
    if (method === "POST") {
      applyModelProfileFields(profile, body);
      applyProfileCatalogModels(state, profile, body);
      profile.updatedAt = new Date().toISOString();
      return modelConfigResponse(state, { profile });
    }
    if (method === "DELETE") {
      if (state.config.profiles.length <= 1) return invalid("model_profile_last", "至少保留一个模型服务。");
      state.config.profiles = state.config.profiles.filter((p) => p.profileId !== profileId);
      state.config.modelProviderOrder = state.config.modelProviderOrder.filter((key) => key !== `profile:${profileId}`);
      state.config.modelCatalogs = state.config.modelCatalogs.filter((c) => c.profileId !== profileId);
      state.config.modelCapabilityProfiles = state.config.modelCapabilityProfiles.filter((c) => c.profileId !== profileId);
      if ((state.config.config as { profileId?: unknown }).profileId === profileId) {
        state.config.config = { ...state.config.profiles[0]! };
      }
      return modelConfigResponse(state);
    }
    return undefined;
  }

  if (profileSubMatch !== null) {
    const profileId = decodeURIComponent(profileSubMatch[1] ?? "");
    const action = profileSubMatch[2] ?? "";
    const profile = state.config.profiles.find((p) => p.profileId === profileId);
    if (profile === undefined) return missing("model_profile_not_found", "未找到模型配置。");
    if (action === "activate" && method === "POST") {
      state.config.config = { ...profile };
      return modelConfigResponse(state, { profile });
    }
    if (action === "model-settings" && method === "POST") {
      const modelId = bodyString(body, "modelId");
      if (modelId.length === 0) return invalid("invalid_model_configuration", "模型 id 不能为空。");
      const settings = (profile.modelSettings as Record<string, unknown> | undefined) ?? {};
      if (body.settings === undefined || body.settings === null) delete settings[modelId];
      else settings[modelId] = body.settings;
      profile.modelSettings = settings;
      return modelConfigResponse(state);
    }
    if (action === "model-catalog" && method === "POST") {
      return modelConfigResponse(state, { catalog: upsertProfileCatalog(state, profileId, profile, body) });
    }
    if (action === "api-key" && method === "GET") {
      if (profile.secretConfigured !== true) return missing("model_provider_key_not_found", "未找到该厂商的 API Key。");
      return json({ ok: true, status: "completed", profileId, apiKey: "demo-stored-key" });
    }
    if (action === "models" && method === "GET") {
      return json({
        error: {
          code: "demo_no_network",
          message: "浏览器 Demo 不发起网络请求；“获取模型”需要连接真实服务，仅桌面版可用。",
        },
      }, 409);
    }
    return undefined;
  }

  if (path === "/api/config/model-provider-order" && method === "POST") {
    if (Array.isArray(body.order)) state.config.modelProviderOrder = body.order.map(String);
    return modelConfigResponse(state);
  }

  if (path === "/api/config/model-provider" && method === "POST") {
    const activeId = (state.config.config as { profileId?: unknown }).profileId;
    const active = state.config.profiles.find((p) => p.profileId === activeId);
    if (active !== undefined) applyModelProfileFields(active, body);
    if (body.defaultAiMode !== undefined) state.config.config.defaultAiMode = body.defaultAiMode;
    return modelConfigResponse(state, { informationAccess: (demoConfig as Record<string, unknown>).informationAccess });
  }

  return undefined;
}

function applyModelProfileFields(profile: Record<string, unknown>, body: Record<string, unknown>): void {
  const assign = (key: string, value: unknown): void => { if (value !== undefined) profile[key] = value; };
  assign("label", bodyString(body, "label") || undefined);
  assign("baseUrl", bodyString(body, "baseUrl") || undefined);
  assign("model", bodyString(body, "model") || undefined);
  assign("protocolKind", body.protocolKind);
  assign("providerKind", body.providerKind);
  assign("defaultAiMode", body.defaultAiMode);
  assign("piProviderId", bodyString(body, "piProviderId") || undefined);
  assign("logoDataUrl", body.logoDataUrl);
  if (body.connection !== undefined && body.connection !== null) profile.connection = body.connection;
  if (typeof body.enabled === "boolean") profile.enabled = body.enabled;
  if (bodyString(body, "apiKey").length > 0) profile.secretConfigured = true;
  if (body.clearApiKey === true) profile.secretConfigured = false;
  if (body.clearModel === true) delete profile.model;
  if (body.clearPiProviderId === true) delete profile.piProviderId;
  if (body.clearLogoDataUrl === true) delete profile.logoDataUrl;
}

function applyProfileCatalogModels(
  state: DemoState,
  profile: Record<string, unknown>,
  body: Record<string, unknown>,
): void {
  if (!Array.isArray(body.models)) return;
  const profileId = String(profile.profileId);
  const catalog = upsertProfileCatalog(state, profileId, profile, body);
  catalog.models = body.models;
}

function upsertProfileCatalog(
  state: DemoState,
  profileId: string,
  profile: Record<string, unknown>,
  body: Record<string, unknown>,
): Record<string, unknown> {
  let catalog = state.config.modelCatalogs.find((c) => c.profileId === profileId);
  if (catalog === undefined) {
    catalog = { profileId, label: profile.label ?? profileId, baseUrl: profile.baseUrl ?? "", modelsPath: "/models", models: [] };
    state.config.modelCatalogs.push(catalog);
  }
  if (bodyString(body, "label")) catalog.label = bodyString(body, "label");
  if (bodyString(body, "baseUrl")) catalog.baseUrl = bodyString(body, "baseUrl");
  return catalog;
}

// ---------------------------------------------------------------------------
// 记忆条目的内存后端（浏览器临时存储，刷新后丢失）
// ---------------------------------------------------------------------------

function memoryRevision(
  entryId: string,
  edit: Record<string, unknown>,
  base: { readonly revisionId: string; readonly revision: number; readonly previousRevisionId: string | null; readonly kind: string },
): Record<string, unknown> {
  const reason = typeof edit.reason === "string" && edit.reason.length > 0
    ? { text: edit.reason, sourceIds: ["demo-user"] }
    : null;
  return {
    revisionId: base.revisionId,
    entryId,
    revision: base.revision,
    previousRevisionId: base.previousRevisionId,
    kind: base.kind,
    origin: "user_edit",
    markdown: bodyString(edit, "markdown"),
    applicability: typeof edit.applicability === "string" && edit.applicability.length > 0 ? edit.applicability : null,
    occurredAt: typeof edit.occurredAt === "string" && edit.occurredAt.length > 0 ? edit.occurredAt : null,
    reportedAt: new Date().toISOString(),
    reason,
    topicIds: Array.isArray(edit.topicIds) ? edit.topicIds : [],
    related: Array.isArray(edit.related) ? edit.related : [],
    sourceIds: ["demo-user"],
    retractsRevisionIds: Array.isArray(edit.retractsRevisionIds) ? edit.retractsRevisionIds : [],
    publishedAt: Date.now(),
  };
}

function memoryEntryView(entry: DemoMemoryEntry): Record<string, unknown> {
  const head = entry.revisions[entry.revisions.length - 1]!;
  return {
    entry: entry.entry,
    revision: head,
    supplyState: "eligible",
    role: head.kind === "withdrawal" ? "withdrawn" : "current",
    currentRevisionId: head.revisionId,
    sources: [{
      sourceId: "demo-user",
      owner: entry.entry.owner,
      locator: { kind: "user_edit", requestId: head.revisionId },
      lifecycle: "present",
      branch: "selected",
      createdAt: entry.entry.createdAt,
      readback: "not_applicable",
    }],
  };
}

function memoryOverview(state: DemoState): Record<string, unknown> | undefined {
  const markdown = state.memory.entries
    .map(memoryEntryView)
    .filter((v) => v.role === "current")
    .map((v) => bodyString(v.revision as Record<string, unknown>, "markdown"))
    .filter((text) => text.length > 0)
    .join("\n\n");
  if (markdown.length === 0) return undefined;
  return {
    revisionId: `memdoc-demo-${state.memory.overviewRevision}`,
    revision: state.memory.overviewRevision,
    origin: "user_edit",
    markdown,
    generation: 0,
    updatedAt: Date.now(),
  };
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
