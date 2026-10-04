/// <reference types="vite/client" />

import inspirationImageUrl from "../panel-server/storage/initial-workbench-assets/灵感·山.jpg?url";
import networkDiagramUrl from "../panel-server/storage/initial-workbench-assets/神经网络结构图.png?url";
import lossCurveUrl from "../panel-server/storage/initial-workbench-assets/训练损失曲线.png?url";
import pytorchPdfUrl from "../panel-server/storage/initial-workbench-assets/PyTorch 入门笔记.pdf?url";
import transformerMarkdown from "../panel-server/storage/initial-workbench-assets/Transformer 精读.md?raw";
import { listPiProviderCatalog } from "../../adapters/intelligence/pi-model-catalog";
import { panelModelProviderPresets } from "../panel-server/settings/model-provider-market-pure";
import {
  DEFAULT_SPACE_ID,
  INITIAL_KNOWLEDGE_ASSIGNMENTS,
  INITIAL_KNOWLEDGE_LINKS,
  INITIAL_KNOWLEDGE_THEMES,
  INITIAL_WORKBENCH_MANAGED_FOLDERS,
  INITIAL_WORKBENCH_NOTES,
  INITIAL_WORKBENCH_SPACES,
  INITIAL_WORKBENCH_WEB_REFERENCES,
  LEARNING_SPACE_ID,
} from "../panel-server/storage/initial-workbench-content";
import type { ConfigResponse } from "@panel-api/config";
import type { OrdinaryRunView, TranscriptNode } from "../panel-ui/src/contracts/run";
import type { Conversation, ConversationSummary } from "../panel-ui/src/contracts/conversation";
import type { SkillDefinition } from "../panel-ui/src/contracts/skills";
import type { SubAgentDefinition } from "../panel-ui/src/contracts/sub-agents";
import type { UsageStatisticsResponse } from "../panel-ui/src/contracts/statistics";
import type { DocumentPreview } from "@panel-api/workbench";
import type { SpaceSummary, SpaceTree } from "@panel-api/spaces";

const createdAt = "2026-09-10T00:00:00.000Z";
const managedRoot = "Synech Demo/内置空间";

const bundledAssetUrls: Readonly<Record<string, string>> = {
  "灵感·山.jpg": inspirationImageUrl,
  "神经网络结构图.png": networkDiagramUrl,
  "训练损失曲线.png": lossCurveUrl,
  "PyTorch 入门笔记.pdf": pytorchPdfUrl,
};

const bundledText: Readonly<Record<string, string>> = {
  "Transformer 精读.md": transformerMarkdown,
};

const knowledgeAssets = [
  { id: "demo-knowledge-inspiration", referenceId: "builtin-my-space-inspiration", relativePath: "灵感·山.jpg", key: "inspiration" },
  { id: "demo-knowledge-pytorch", referenceId: "builtin-learning-study-materials", relativePath: "PyTorch 入门笔记.pdf", key: "pytorch" },
  { id: "demo-knowledge-network", referenceId: "builtin-learning-study-materials", relativePath: "神经网络结构图.png", key: "network-diagram" },
  { id: "demo-knowledge-loss", referenceId: "builtin-learning-study-materials", relativePath: "训练损失曲线.png", key: "loss-curve" },
  { id: "demo-knowledge-card-notes", referenceId: "builtin-learning-reading-notes", relativePath: "卡片笔记法完整介绍.md", key: "card-notes" },
  { id: "demo-knowledge-transformer", referenceId: "builtin-learning-reading-notes", relativePath: "Transformer 精读.md", key: "transformer" },
] as const;

const knowledgeIdByKey = new Map(knowledgeAssets.map((asset) => [asset.key, asset.id]));

const demoProfile = {
  profileId: "demo",
  label: "Synech Demo",
  providerKind: "openai_compatible" as const,
  protocolKind: "openai_responses" as const,
  baseUrl: "https://api.openai.com/v1",
  model: "synech-demo",
  defaultAiMode: "openai-responses" as const,
  secretRef: "secret://demo/model-provider",
  enabled: true,
  secretConfigured: true,
  updatedAt: createdAt,
};

export const demoConfig: ConfigResponse = {
  ok: true,
  status: "completed",
  product: {
    name: "Synech",
    version: "1.0.1-demo",
    defaultEntry: "Workbench",
    configDirectory: "Browser demo",
    productHome: "Browser demo",
  },
  config: demoProfile,
  profiles: [demoProfile],
  modelProviderOrder: ["profile:demo"],
  modelCatalogs: [{
    profileId: "demo",
    label: "Synech Demo",
    baseUrl: demoProfile.baseUrl,
    modelsPath: "/models",
    fetchedAt: createdAt,
    models: [{ id: "synech-demo", displayName: "Synech Demo", owner: "Synech" }],
  }],
  modelCapabilityProfiles: [{
    profileId: "demo",
    providerKind: "openai_compatible",
    protocolKind: "openai_responses",
    model: "synech-demo",
    capabilities: demoModelCapabilities(),
  }],
  modelProviderMarket: { presets: panelModelProviderPresets(listPiProviderCatalog()) },
  commandShell: {
    configuredKind: "auto",
    kind: "powershell",
    label: "PowerShell",
    syntax: "powershell",
    platform: "win32",
    updatedAt: createdAt,
  },
  toolConfirmation: { policy: "prompt", updatedAt: createdAt },
  ordinaryAgent: {
    systemPrompt: "Synech browser demo",
    systemPromptVariant: "en",
    isDefault: true,
    updatedAt: createdAt,
  },
  skillTrigger: { mode: "keyword", updatedAt: createdAt },
  capabilities: {
    modelCapabilities: demoModelCapabilities(),
    warnings: ["当前为浏览器 Demo：本地文件与真实模型调用仅在桌面版可用。"],
  },
};

export const demoTools = {
  ok: true,
  status: "completed",
  tools: {
    webSearch: {
      provider: "none",
      providerKind: "tavily",
      maxResults: 5,
      secretConfigured: false,
      status: "no-provider",
      updatedAt: createdAt,
    },
    catalog: {
      tools: [
        demoTool("Read", "读取文件", "读取工作区或附件中的文本内容。", "read-only", "low"),
        demoTool("Grep", "搜索文件", "在工作区中搜索文本与代码。", "read-only", "low"),
        demoTool("Edit", "编辑文件", "精确修改工作区中的文本文件。", "read-write", "medium"),
        demoTool("WebSearch", "搜索网页", "搜索并整理公开网页信息。", "read-only", "low"),
      ],
    },
  },
  mcpCatalog: [],
};

export const demoSkills: readonly SkillDefinition[] = [
  {
    id: "deep-research",
    name: "deep-research",
    description: "围绕明确问题检索、核验并整理有引用的研究结论。",
    enabled: true,
    category: "研究",
    sourceKind: "user",
    sourceRootId: "demo",
    stateKey: "demo:deep-research",
  },
  {
    id: "document-workflow",
    name: "document-workflow",
    description: "读取资料并生成结构清晰、可继续编辑的文档。",
    enabled: true,
    category: "文档",
    sourceKind: "user",
    sourceRootId: "demo",
    stateKey: "demo:document-workflow",
  },
];

export const demoSubAgents: readonly SubAgentDefinition[] = [];

export function listDemoSpaces(): readonly SpaceSummary[] {
  return INITIAL_WORKBENCH_SPACES.map((space) => {
    const references = referenceItemsForSpace(space.id);
    return {
      id: space.id,
      title: space.title,
      createdAt,
      updatedAt: createdAt,
      folderCount: references.filter((item) => item.reference.kind === "managed_folder").length,
      referenceItemCount: references.length,
    };
  });
}

export function getDemoSpaceTree(spaceId: string): SpaceTree | undefined {
  const space = INITIAL_WORKBENCH_SPACES.find((candidate) => candidate.id === spaceId);
  if (space === undefined) return undefined;
  return {
    space: { id: space.id, title: space.title, createdAt, updatedAt: createdAt },
    entries: referenceItemsForSpace(space.id).map((item) => ({ kind: "reference" as const, item })),
  };
}

export function getDemoSpacePreview(referenceId: string, relativePath: string): DocumentPreview | undefined {
  const folder = INITIAL_WORKBENCH_MANAGED_FOLDERS.find((candidate) => candidate.id === referenceId);
  if (folder !== undefined) {
    if (relativePath.length === 0) {
      return {
        itemId: referenceId,
        title: folder.title,
        sourceKind: "managed_folder",
        source: `${managedRoot}/${folder.title}`,
        status: "ready",
        presentation: { kind: "directory", editable: false, sourceMode: false },
        fingerprint: `demo-directory:${referenceId}`,
        modifiedAt: Date.parse(createdAt),
        content: {
          kind: "directory",
          relativePath: "",
          entries: folder.files.map((file) => ({ name: file.relativePath, relativePath: file.relativePath, kind: "file" as const })),
          truncated: false,
        },
      };
    }
    const file = folder.files.find((candidate) => candidate.relativePath === relativePath);
    if (file === undefined) return undefined;
    const caption = folder.imageCaptions?.[relativePath];
    const text = file.source === "text" ? file.content : bundledText[file.assetFileName];
    return filePreview({
      itemId: referenceId,
      title: folder.title,
      sourceKind: "managed_folder",
      source: `${managedRoot}/${folder.title}/${relativePath}`,
      fileName: relativePath,
      text,
      caption,
    });
  }
  const web = INITIAL_WORKBENCH_WEB_REFERENCES.find((candidate) => candidate.id === referenceId);
  if (web === undefined || relativePath.length > 0) return undefined;
  return {
    itemId: web.id,
    title: web.title,
    sourceKind: "web_page",
    source: web.url,
    status: "ready",
    presentation: { kind: "web", editable: false, sourceMode: false },
    annotation: annotationFrom(web.annotation),
    content: { kind: "web", url: web.url, site: web.id.endsWith("distill") ? "Distill" : "Stanford" },
  };
}

export function getDemoKnowledgePreview(assetId: string): DocumentPreview | undefined {
  const asset = knowledgeAssets.find((candidate) => candidate.id === assetId);
  if (asset === undefined) return undefined;
  const source = getDemoSpacePreview(asset.referenceId, asset.relativePath);
  if (source === undefined) return undefined;
  return {
    ...source,
    itemId: asset.id,
    title: asset.relativePath,
    sourceKind: "knowledge_asset",
    source: `Synech Demo/知识库/${asset.relativePath}`,
  };
}

export type DemoKnowledgeSnapshot = {
  notes: Array<{
    id: string;
    spaceId?: string;
    title: string;
    bodyMarkdown: string;
    createdAt: number;
    updatedAt: number;
    revision: number;
  }>;
  pages: Array<{
    refId: string;
    kind: "note" | "space_reference";
    collectedAt: number;
    asset?: {
      status: "managed";
      title: string;
      sourceLabel: string;
      contentKind: "file";
      sourceReferenceId: string;
      sourceRelativePath: string;
    };
  }>;
  links: Array<{ from: string; to: string }>;
  themes: Array<{ id: string; name: string; color: string; origin: "agent" | "user" }>;
  assignments: Array<{ refId: string; themeId: string; by: "agent" | "user"; locked: boolean }>;
  recentlyOpened: Record<string, number>;
};

export function createDemoKnowledgeSnapshot(): DemoKnowledgeSnapshot {
  const timestamp = Date.now();
  const notePages = INITIAL_WORKBENCH_NOTES.map((note, index) => ({
    id: note.id,
    spaceId: note.spaceId,
    title: note.title,
    bodyMarkdown: note.bodyMarkdown,
    createdAt: timestamp - (index + 1) * 60_000,
    updatedAt: timestamp - (index + 1) * 60_000,
    revision: 1,
  }));
  return {
    notes: notePages,
    pages: knowledgeAssets.map((asset, index) => ({
      refId: asset.id,
      kind: "space_reference" as const,
      collectedAt: timestamp - index * 30_000,
      asset: {
        status: "managed" as const,
        title: asset.relativePath,
        sourceLabel: `Synech Demo/知识库/${asset.relativePath}`,
        contentKind: "file" as const,
        sourceReferenceId: asset.referenceId,
        sourceRelativePath: asset.relativePath,
      },
    })),
    links: INITIAL_KNOWLEDGE_LINKS.flatMap((link) => {
      const from = knowledgeIdByKey.get(link.fromCollectionKey);
      const to = knowledgeIdByKey.get(link.toCollectionKey);
      return from === undefined || to === undefined ? [] : [{ from, to }];
    }),
    themes: INITIAL_KNOWLEDGE_THEMES.map((theme) => ({ ...theme })),
    assignments: INITIAL_KNOWLEDGE_ASSIGNMENTS.flatMap((assignment) => {
      const refId = knowledgeIdByKey.get(assignment.collectionKey);
      return refId === undefined ? [] : [{ refId, themeId: assignment.themeId, by: "agent" as const, locked: false }];
    }),
    recentlyOpened: {},
  };
}

export function createDemoConversation(
  goal: string,
  owner: Conversation["owner"],
  previous?: Conversation,
): { conversation: Conversation; runView: OrdinaryRunView } {
  const now = new Date().toISOString();
  const conversationId = previous?.conversationId ?? `demo-conversation-${crypto.randomUUID()}`;
  const runId = `demo-run-${crypto.randomUUID()}`;
  const answer = demoAnswer(goal);
  const nodes = demoTranscriptNodes(runId, now, answer);
  const run = {
    runId,
    conversationId,
    title: goal,
    goalSummary: goal,
    status: "completed" as const,
    createdAt: now,
    updatedAt: now,
    currentStep: "演示结果已生成",
    nextStep: "可继续输入，体验多轮对话",
    requiresUserAction: false,
    eventCursor: { lastSequence: 3, eventCount: 3 },
  };
  const runView: OrdinaryRunView = {
    run,
    capabilityResolution: { modelContextWindowTokens: 128_000 },
    workView: {
      run,
      stage: "completed",
      headline: "任务已完成",
      currentAction: "已生成浏览器 Demo 回复",
      contextAttachments: [],
      answer: {
        title: "Synech",
        content: answer,
        evidenceRefs: [],
        nextActions: ["继续追问", "打开空间资料", "查看知识库"],
      },
      visibleEvents: [],
      transcriptNodes: nodes,
      workSummary: {
        summary: "已理解请求并生成演示回复。",
        pendingActionCount: 0,
        toolResultCount: 1,
        contextAttachmentCount: 0,
      },
    },
    detail: {
      runId,
      status: "completed",
      transcript: { transcriptNodes: nodes },
      stopReason: "completed",
      continuationAvailability: "new_turn",
      toolResults: [],
      usage: { requestCount: 1, inputTokens: 96, outputTokens: 168, totalTokens: 264, latencyMs: 420 },
    },
    replay: {
      reset: false,
      events: [],
      cursor: { token: "3", lastSequence: 3 },
    },
  };
  const userTurn = {
    turnId: `demo-user-${crypto.randomUUID()}`,
    role: "user" as const,
    title: "你的消息",
    content: goal,
    status: "completed",
    createdAt: now,
    updatedAt: now,
    runId,
  };
  const assistantTurn = {
    turnId: `demo-assistant-${crypto.randomUUID()}`,
    role: "assistant" as const,
    title: "Synech",
    content: answer,
    status: "completed",
    createdAt: now,
    updatedAt: now,
    runId,
    responseModel: {
      profileId: "demo",
      label: "Synech Demo",
      providerKind: "openai_compatible",
      protocolKind: "openai_responses",
      model: "synech-demo",
    },
  };
  return {
    conversation: {
      conversationId,
      owner: previous?.owner ?? owner,
      spaceId: (previous?.owner ?? owner)?.kind === "space" ? (previous?.owner ?? owner)?.id : undefined,
      title: previous?.title ?? goal.slice(0, 36),
      turns: [...(previous?.turns ?? []), userTurn, assistantTurn],
      latestRunId: runId,
      currentRun: runView,
      queuedRunIds: [],
      updatedAt: now,
    },
    runView,
  };
}

export function summarizeDemoConversation(conversation: Conversation): ConversationSummary {
  const lastTurn = conversation.turns.at(-1);
  return {
    conversationId: conversation.conversationId,
    owner: conversation.owner,
    spaceId: conversation.spaceId,
    title: conversation.title,
    preview: lastTurn?.content.slice(0, 80),
    status: "completed",
    latestRunId: conversation.latestRunId,
    queuedRunIds: [],
    queuedRunCount: 0,
    updatedAt: conversation.updatedAt,
    requiresUserAction: false,
    pinnedAt: conversation.pinnedAt,
  };
}

export function demoUsageStatistics(): UsageStatisticsResponse {
  return {
    ok: true,
    status: "completed",
    statistics: {
      generatedAt: new Date().toISOString(),
      storageAvailable: true,
      scope: "all_local",
      heatmapWindowDays: 182,
      totals: {
        conversationCount: 3,
        messageCount: 8,
        runCount: 4,
        requestCount: 6,
        inputTokens: 8_420,
        outputTokens: 2_160,
        totalTokens: 10_580,
        cacheSavedTokens: 1_260,
        cacheHitRate: 0.15,
      },
      modelBreakdown: [{
        providerId: "demo",
        providerLabel: "Synech Demo",
        model: "synech-demo",
        requestCount: 6,
        inputTokens: 8_420,
        outputTokens: 2_160,
        totalTokens: 10_580,
        cacheSavedTokens: 1_260,
        cacheHitRate: 0.15,
        averageFirstTokenLatencyMs: 420,
      }],
      dailyActivity: [],
    },
  };
}

function referenceItemsForSpace(spaceId: string) {
  const folders = INITIAL_WORKBENCH_MANAGED_FOLDERS
    .filter((folder) => folder.spaceId === spaceId)
    .map((folder) => ({
      id: folder.id,
      spaceId,
      title: folder.title,
      reference: { kind: "managed_folder" as const, path: `${managedRoot}/${folder.title}` },
      ...(folder.imageCaptions === undefined ? {} : {
        imageCaptions: Object.fromEntries(Object.entries(folder.imageCaptions).map(([name, text]) => [name, {
          text,
          revision: 1,
          updatedAt: createdAt,
          updatedBy: "agent" as const,
          actor: { kind: "agent" as const, actorId: "synech-initial-content" },
        }])),
      }),
      createdAt,
      updatedAt: createdAt,
    }));
  const web = INITIAL_WORKBENCH_WEB_REFERENCES
    .filter((reference) => reference.spaceId === spaceId)
    .map((reference) => ({
      id: reference.id,
      spaceId,
      title: reference.title,
      reference: { kind: "web_page" as const, url: reference.url },
      annotation: annotationFrom(reference.annotation),
      webMetadata: {
        status: "ready" as const,
        finalUrl: reference.url,
        pageTitle: reference.title,
        siteName: reference.id.endsWith("distill") ? "Distill" : "Stanford",
        fetchedAt: createdAt,
      },
      createdAt,
      updatedAt: createdAt,
    }));
  return [...folders, ...web];
}

function annotationFrom(annotation: {
  readonly markdown: string;
  readonly keyPoints?: readonly string[];
  readonly tags?: readonly string[];
} | undefined) {
  if (annotation === undefined) return undefined;
  return {
    ...annotation,
    revision: 1,
    updatedAt: createdAt,
    updatedBy: "agent" as const,
    actor: { kind: "agent" as const, actorId: "synech-initial-content" },
  };
}

function filePreview(input: {
  itemId: string;
  title: string;
  sourceKind: "managed_folder" | "knowledge_asset";
  source: string;
  fileName: string;
  text?: string;
  caption?: string;
}): DocumentPreview | undefined {
  const extension = input.fileName.split(".").at(-1)?.toLowerCase();
  if (input.text !== undefined) {
    return {
      itemId: input.itemId,
      title: input.title,
      sourceKind: input.sourceKind,
      source: input.source,
      status: "ready",
      presentation: { kind: extension === "md" ? "markdown" : "text", editable: true, sourceMode: true },
      fingerprint: `demo-text:${input.itemId}:${input.fileName}`,
      byteLength: new TextEncoder().encode(input.text).byteLength,
      modifiedAt: Date.parse(createdAt),
      content: { kind: "text", text: input.text, truncated: false, editable: true, language: extension === "md" ? "md" : undefined, encoding: "UTF-8" },
    };
  }
  const url = bundledAssetUrls[input.fileName];
  if (url === undefined) return undefined;
  const mimeType = extension === "pdf" ? "application/pdf" : extension === "jpg" ? "image/jpeg" : "image/png";
  if (extension === "pdf") {
    return {
      itemId: input.itemId,
      title: input.title,
      sourceKind: input.sourceKind,
      source: input.source,
      status: "ready",
      presentation: { kind: "pdf", editable: false, sourceMode: false },
      fingerprint: `demo-file:${input.itemId}:${input.fileName}`,
      content: { kind: "media", mediaKind: "pdf", mimeType, url },
    };
  }
  return {
    itemId: input.itemId,
    title: input.title,
    sourceKind: input.sourceKind,
    source: input.source,
    status: "ready",
    presentation: { kind: "image", editable: false, sourceMode: false },
    fingerprint: `demo-file:${input.itemId}:${input.fileName}`,
    content: {
      kind: "media",
      mediaKind: "image",
      mimeType,
      url,
      caption: input.caption,
      captionEditable: true,
      captionFingerprint: "demo-caption:1",
    },
  };
}

function demoTranscriptNodes(runId: string, timestamp: string, answer: string): readonly TranscriptNode[] {
  return [
    {
      nodeId: `${runId}:thinking`,
      runId,
      sequence: 1,
      eventType: "model.reasoning.completed",
      kind: "thinking",
      phase: "completed",
      title: "理解任务",
      summary: "已识别目标与当前空间上下文。",
      text: "先确认用户目标，再从当前空间与知识库中组织可执行的回答。",
      timestamp,
      refs: [],
    },
    {
      nodeId: `${runId}:tool`,
      runId,
      sequence: 2,
      eventType: "tool.completed",
      kind: "tool",
      phase: "completed",
      title: "检查相关知识",
      summary: "已检查 Demo 空间与知识库中的相关资料。",
      timestamp,
      toolName: "KnowledgeSearch",
      refs: [],
    },
    {
      nodeId: `${runId}:answer`,
      runId,
      sequence: 3,
      eventType: "final.result",
      kind: "answer",
      phase: "completed",
      title: "完成",
      text: answer,
      timestamp,
      refs: [],
    },
  ];
}

function demoAnswer(goal: string): string {
  const quotedGoal = goal.length > 120 ? `${goal.slice(0, 120)}…` : goal;
  return `我已经收到你的请求：**${quotedGoal}**\n\n这是 Synech 原始工作台中的浏览器 Demo 会话。你可以继续追问，也可以从左侧打开“我的空间”“学习空间”和知识库，体验真实的导航、资料预览与多轮对话流程。\n\n在线版本不会访问你的本地文件，也不会调用真实模型；这两项能力只在桌面版中启用。`;
}

function demoModelCapabilities() {
  return {
    facts: {
      status: "confirmed" as const,
      piProviderId: "demo",
      modelId: "synech-demo",
      transport: "openai_responses" as const,
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
      supportsVisionInput: true,
      supportsReasoningOutput: true,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"] as const,
      supportsStrictToolSchemas: true,
      supportsParallelToolCalls: true,
    },
  };
}

function demoTool(
  name: string,
  displayName: string,
  displayDescription: string,
  operationType: "read-only" | "read-write",
  riskLevel: "low" | "medium",
) {
  return {
    name,
    displayName,
    displayDescription,
    description: displayDescription,
    inputSchema: { type: "object", properties: {} },
    category: operationType === "read-only" ? "filesystem" : "workspace",
    categoryLabel: operationType === "read-only" ? "文件系统" : "工作区",
    riskLevel,
    riskLabel: riskLevel === "low" ? "低风险" : "中风险",
    operationType,
    operationLabel: operationType === "read-only" ? "只读" : "读写",
    requiresConfirmation: false,
    confirmationLabel: "可用",
    scopes: ["agent-basic", "workspace"],
    enabledByDefault: true,
    availability: "available",
  };
}

export { DEFAULT_SPACE_ID, LEARNING_SPACE_ID };
