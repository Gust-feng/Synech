import { cleanConfirmationSummary, isGenericApprovalDecisionText } from "../../text-projection/confirmation-copy.js";
import {
  isFileReadNode,
  isModelSideOutputNode,
  normalizedToolName,
  type ProjectableTranscriptNode,
} from "./panel-transcript-node-projection.js";
import { commandText, genericItemLabel } from "./panel-transcript-tool-format.js";
import { cleanOrdinaryToolText } from "../../tool-projection/ordinary-tool-copy.js";

const EXPANDED_SEARCH_RESULTS_LIMIT = 20;
const EXPANDED_DIRECTORY_ENTRIES_LIMIT = 80;
const EXPANDED_FILE_SEARCH_MATCHES_LIMIT = 80;

function isString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

export type ActivityLineCopy = {
  readonly label?: string;
  readonly detail: string;
  readonly expandedDetail?: string;
};

export type ActivityExpandedMeta = {
  readonly label?: string;
  readonly value: string;
};

export type ActivityExpandedItem = {
  readonly title: string;
  readonly detail?: string;
  readonly href?: string;
  readonly meta?: readonly ActivityExpandedMeta[];
  readonly monospace?: boolean;
};

export type ActivityExpandedSection = {
  readonly title: string;
  readonly content: string;
  readonly format?: "plain" | "code" | "console" | "list" | "diagnostics" | "source" | "source_list" | "path_list" | "quote" | "diff";
  readonly href?: string;
  readonly meta?: readonly ActivityExpandedMeta[];
  readonly items?: readonly ActivityExpandedItem[];
  readonly note?: string;
  readonly tone?: "neutral" | "accent" | "success" | "warning" | "danger";
};

export type ActivityBadge = {
  readonly label: string;
  readonly tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  readonly monospace?: boolean;
};

export type ActivityLineDelta = {
  readonly added: number;
  readonly removed: number;
};

export type ActivityLead = {
  readonly action: string;
  readonly subject: string;
  readonly context?: string;
  readonly monospace?: boolean;
};

export type ActivityItem = {
  readonly nodeId: string;
  readonly key: string;
  /** Source event identity used for presentation decisions without parsing display copy. */
  readonly eventType: string;
  /** Stable tool fact identity used to attach nested sub-agent work. */
  readonly toolCallFactId?: string;
  /** Parent AgentTool fact for nested sub-agent work. */
  readonly parentToolCallFactId?: string;
  /** Nested mechanical activity owned by this AgentTool invocation. */
  readonly children?: readonly ActivityItem[];
  readonly variant?: "context_compaction";
  readonly copy: ActivityLineCopy;
  readonly tone: "thinking" | "narration" | "tool" | "confirmation" | "decision" | "system";
  readonly phase: ProjectableTranscriptNode["phase"];
  readonly startedAt?: string;
  readonly toolKind?: "command" | "search" | "read" | "directory" | "edit" | "web" | "agent" | "thinking" | "system" | "confirmation" | "decision" | "other";
  readonly lead?: ActivityLead;
  readonly lineDelta?: ActivityLineDelta;
  readonly statusBadge?: ActivityBadge;
  readonly badges?: readonly ActivityBadge[];
  readonly expandedSections?: readonly ActivityExpandedSection[];
};

export type ActivityToolKind = NonNullable<ActivityItem["toolKind"]>;

export function isVisibleOrdinaryActivityItem(item: ActivityItem): boolean {
  return item.eventType.startsWith("model.reasoning.") ||
    item.tone === "tool" ||
    item.phase === "failed" ||
    item.phase === "blocked" ||
    item.phase === "cancelled" ||
    item.tone === "confirmation" ||
    item.tone === "decision";
}

export function activityLineForNode(node: ProjectableTranscriptNode): ActivityLineCopy | undefined {
  if (node.kind === "thinking") {
    return readableThinkingCopy(node.text ?? node.summary ?? "");
  }
  if (node.kind === "tool") {
    const target = toolTargetCopy(node);
    const statusText = target === undefined ? toolStatusText(node) : undefined;
    if (target === undefined && statusText === undefined) {
      return undefined;
    }
    const copy = {
      label: toolVerb(node),
      detail: target?.detail ?? statusText ?? "",
    };
    return target?.expandedDetail === undefined ? copy : { ...copy, expandedDetail: target.expandedDetail };
  }
  if (node.kind === "confirmation") {
    return readableConfirmationCopy(node);
  }
  if (node.kind === "user_decision") {
    return readableUserDecisionCopy(node);
  }
  if (node.kind === "system") {
    if (isModelRequestNode(node)) {
      return { detail: node.summary?.trim() || "思考中" };
    }
    if (isContextCompactionNode(node)) {
      return contextCompactionActivityCopy(node);
    }
    if (isModelSideOutputNode(node)) {
      return readableNarrationCopy(node.text ?? node.summary ?? "");
    }
    if (node.phase === "failed" || node.phase === "blocked") {
      return {
        label: node.eventType === "model.failed" ? "模型" : "问题",
        detail: readableNarrationText(node.text ?? node.summary ?? node.title) ?? "运行失败。",
      };
    }
    if (node.phase === "cancelled") return { label: "已停止", detail: "任务已取消。" };
    const detail = readableNarrationText(node.text ?? node.summary ?? node.title);
    return detail === undefined ? undefined : { detail };
  }
  return undefined;
}

export function resolveActivityToolKind(item: {
  readonly tone: ActivityItem["tone"];
  readonly copy: { readonly label?: string };
  readonly displayKind?: NonNullable<ProjectableTranscriptNode["display"]>["kind"];
}): ActivityToolKind {
  if (item.tone === "thinking") return "thinking";
  if (item.tone === "confirmation") return "confirmation";
  if (item.tone === "decision") return "decision";
  if (item.tone === "system") return "system";
  if (item.displayKind === "command_summary") return "command";
  if (item.displayKind === "search_results" || item.displayKind === "file_search_results") return "search";
  if (item.displayKind === "directory_listing") return "directory";
  if (item.displayKind === "read_result") return "read";
  if (item.displayKind === "web_fetch" || item.displayKind === "http_response") return "web";
  if (item.displayKind === "agent_task") return "agent";
  if (
    item.displayKind === "file_change_summary" ||
    item.displayKind === "file_diff_preview" ||
    item.displayKind === "file_change_group"
  ) return "edit";
  const label = item.copy.label;
  if (label === "命令") return "command";
  if (label === "搜索") return "search";
  if (label === "读取" || label === "查看") return "read";
  if (label === "编辑" || label === "写入" || label === "创建" || label === "删除") return "edit";
  if (label === "网页") return "web";
  if (label === "委派") return "agent";
  if (label === "生成") return "edit";
  return "other";
}

export function activityItemsForNodes(nodes: readonly ProjectableTranscriptNode[]): readonly ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const node of nodes) {
    const copy = activityLineForNode(node);
    if (copy === undefined) continue;
    const tone = activityToneForNode(node);
    const item: ActivityItem = {
      nodeId: node.nodeId,
      key: activityItemKey(node),
      eventType: node.eventType,
      variant: activityVariantForNode(node),
      copy,
      tone,
      phase: node.phase,
      startedAt: node.timestamp || undefined,
      toolKind: resolveActivityToolKind({ tone, copy, displayKind: node.display?.kind }),
      lead: activityLeadForNode(node, copy),
      lineDelta: activityLineDeltaForNode(node, copy),
      statusBadge: activityStatusBadge(node),
      badges: activityBadgesForNode(node),
      expandedSections: activityExpandedSectionsForNode(node, copy),
    };
    items.push(item);
  }
  return items;
}

export function displayActivityItemsForNodes(nodes: readonly ProjectableTranscriptNode[]): readonly ActivityItem[] {
  const items: ActivityItem[] = [];
  const requestedToolItemIndexByCall = new Map<string, number>();
  const failureCauseKeysByRun = new Map<string, Set<string>>();
  for (const node of nodes) {
    const copy = activityLineForNode(node);
    if (copy === undefined) continue;
    const item = activityItemFromNode(node, copy);
    if (isRedundantRunFailureItem(node, item, failureCauseKeysByRun)) {
      continue;
    }
    recordFailureCauseKey(node, item, failureCauseKeysByRun);
    const toolCallId = toolCallIdForActivityNode(node);
    if (toolCallId !== undefined && node.kind === "tool") {
      const previousIndex = requestedToolItemIndexByCall.get(toolCallId);
      if (previousIndex !== undefined && isTerminalToolNode(node)) {
        const previous = items[previousIndex];
        if (previous !== undefined) {
          items[previousIndex] = mergeToolActivityItems(previous, item);
          continue;
        }
      }
      if (node.eventType === "tool.requested") {
        requestedToolItemIndexByCall.set(toolCallId, items.length);
      }
    }
    items.push(
      item.copy.expandedDetail !== undefined && item.expandedSections === undefined
        ? { ...item, expandedSections: [{ title: "详情", content: item.copy.expandedDetail }] }
        : item,
    );
  }
  return nestDelegatedActivityItems(items);
}

function isRedundantRunFailureItem(
  node: ProjectableTranscriptNode,
  item: ActivityItem,
  failureCauseKeysByRun: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (!isRunFailureNode(node)) {
    return false;
  }
  const key = failureCauseKey(item);
  return key.length > 0 && failureCauseKeysByRun.get(node.runId)?.has(key) === true;
}

function recordFailureCauseKey(
  node: ProjectableTranscriptNode,
  item: ActivityItem,
  failureCauseKeysByRun: Map<string, Set<string>>,
): void {
  if (!isFailureCauseNode(node)) {
    return;
  }
  const key = failureCauseKey(item);
  if (key.length === 0) {
    return;
  }
  const existing = failureCauseKeysByRun.get(node.runId) ?? new Set<string>();
  existing.add(key);
  failureCauseKeysByRun.set(node.runId, existing);
}

function isFailureCauseNode(node: ProjectableTranscriptNode): boolean {
  return !isRunFailureNode(node) &&
    (node.phase === "failed" || node.phase === "blocked" || node.phase === "cancelled");
}

function isRunFailureNode(node: ProjectableTranscriptNode): boolean {
  return node.kind === "system" &&
    (node.eventType === "run.failed" || node.eventType === "run.blocked" || node.eventType === "run.cancelled");
}

function failureCauseKey(item: ActivityItem): string {
  return item.copy.detail.replace(/\s+/g, " ").trim();
}

function activityItemFromNode(node: ProjectableTranscriptNode, copy: ActivityLineCopy): ActivityItem {
  const tone = activityToneForNode(node);
  return {
    nodeId: node.nodeId,
    key: activityItemKey(node),
    eventType: node.eventType,
    toolCallFactId: toolCallIdForActivityNode(node),
    ...(node.parentToolCallFactId === undefined ? {} : { parentToolCallFactId: node.parentToolCallFactId }),
    variant: activityVariantForNode(node),
    copy,
    tone,
    phase: node.phase,
    startedAt: node.timestamp || undefined,
    toolKind: resolveActivityToolKind({ tone, copy, displayKind: node.display?.kind }),
    lead: activityLeadForNode(node, copy),
    lineDelta: activityLineDeltaForNode(node, copy),
    statusBadge: activityStatusBadge(node),
    badges: activityBadgesForNode(node),
    expandedSections: activityExpandedSectionsForNode(node, copy),
  };
}

function nestDelegatedActivityItems(items: readonly ActivityItem[]): readonly ActivityItem[] {
  const parents = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    if (item.toolKind === "agent" && item.toolCallFactId !== undefined) {
      parents.set(item.toolCallFactId, index);
    }
  }
  const childIndexes = new Set<number>();
  const childrenByParent = new Map<number, ActivityItem[]>();
  for (const [index, item] of items.entries()) {
    const parentIndex = item.parentToolCallFactId === undefined
      ? undefined
      : parents.get(item.parentToolCallFactId);
    if (parentIndex === undefined || parentIndex === index) continue;
    const children = childrenByParent.get(parentIndex) ?? [];
    children.push(item);
    childrenByParent.set(parentIndex, children);
    childIndexes.add(index);
  }
  return items.flatMap((item, index) => {
    if (childIndexes.has(index)) return [];
    const children = childrenByParent.get(index);
    return children === undefined ? [item] : [{ ...item, children }];
  });
}

function activityLeadForNode(
  node: ProjectableTranscriptNode,
  copy: ActivityLineCopy,
): ActivityLead | undefined {
  if (node.kind !== "tool") {
    return undefined;
  }
  const action = copy.label ?? toolVerb(node);
  const display = node.display;
  if (display?.kind === "command_summary") {
    const issue = node.phase === "failed" || node.phase === "blocked" ||
      (display.exitCode !== undefined && display.exitCode !== 0) || display.timedOut === true;
    return makeActivityLead({
      action: "运行",
      subject: "终端",
      context: issue
        ? display.timedOut === true ? "执行超时" : "运行失败"
        : undefined,
    });
  }
  if (display?.kind === "search_results") {
    return makeActivityLead({
      action,
      subject: cleanToolTargetText(display.query) ?? display.results?.[0]?.title ?? copy.detail,
      context: node.phase === "failed" || node.phase === "blocked"
        ? cleanToolTargetText(display.message)
        : undefined,
    });
  }
  if (display?.kind === "directory_listing") {
    return makeActivityLead({
      action,
      subject: toolPathLabel(display.path) ?? copy.detail,
      monospace: true,
    });
  }
  if (display?.kind === "file_search_results") {
    const matches = fileSearchMatchesReturned(display);
    return makeActivityLead({
      action,
      subject: cleanToolTargetText(display.query) ?? "项目内容",
      context: node.phase === "completed" && matches === 0
        ? "未找到匹配"
        : undefined,
      monospace: true,
    });
  }
  if (display?.kind === "read_result") {
    const remote = display.url !== undefined || urlLikeValue(display.uri) !== undefined;
    const subject = readResultTarget(display, node.summary) ?? copy.detail;
    return makeActivityLead({
      action,
      subject,
      context: display.error,
      monospace: !remote,
    });
  }
  if (display?.kind === "web_fetch") {
    const subject = cleanToolTargetText(display.title ?? display.url) ?? copy.detail;
    return makeActivityLead({
      action,
      subject,
    });
  }
  if (display?.kind === "http_response") {
    const request = [display.method, display.url]
      .filter((value): value is string => value !== undefined && value.trim().length > 0)
      .join(" ");
    const status = display.statusCode === undefined || display.statusCode < 400
      ? undefined
      : [`HTTP ${display.statusCode}`, display.statusText].filter(isString).join(" ");
    return makeActivityLead({
      action,
      subject: request || copy.detail,
      context: status,
      monospace: true,
    });
  }
  if (display?.kind === "agent_task") {
    const agentName = cleanToolTargetText(display.agentName);
    const task = cleanToolTargetText(display.task);
    return makeActivityLead({
      action: "委派",
      subject: agentName ?? task ?? "协作任务",
      context: agentName === undefined ? undefined : task,
    });
  }
  if (display?.kind === "knowledge_operation") {
    return makeActivityLead({
      action,
      subject: cleanToolTargetText(display.query ?? display.title ?? display.noteId ?? display.spaceId) ?? "个人知识",
      context: display.status,
    });
  }
  if (display?.kind === "space_operation") {
    return makeActivityLead({
      action,
      subject: cleanToolTargetText(display.title ?? display.spaceId ?? display.targetId) ?? "空间",
      context: display.status,
    });
  }
  if (display?.kind === "note_operation") {
    return makeActivityLead({
      action: "记录",
      subject: display.scope === "global" ? "全局笔记" : display.scope === "workspace" ? "工作区笔记" : "Agent 笔记",
      context: display.status,
    });
  }
  if (display?.kind === "file_change_summary" || display?.kind === "file_diff_preview") {
    return makeActivityLead({
      action,
      subject: cleanToolTargetText(display.path) ?? copy.detail,
      monospace: display.path !== undefined,
    });
  }
  if (display?.kind === "file_change_group") {
    return makeActivityLead({
      action,
      subject: `${display.files.length} 个文件`,
    });
  }
  if (display?.kind === "generic_tool_summary" || display?.kind === "raw_tool_result") {
    const directory = genericDirectoryFacts(display);
    if (directory !== undefined) {
      return makeActivityLead({
        action,
        subject: toolPathLabel(directory.path) ?? copy.detail,
        monospace: true,
      });
    }
    const role = genericToolRole(normalizedToolName(node.toolName), display);
    const firstItem = display.items
      ?.map((item) => cleanToolTargetText(genericItemLabel(item)))
      .find((item): item is string => item !== undefined);
    const article = genericArticleFacts(display);
    const genericSubject = role === "命令"
      ? "终端"
      : role === "搜索"
        ? cleanToolTargetText(display.summary) ?? firstItem ?? copy.detail
        : article.title ?? compactHostLabel(article.url) ?? copy.detail;
    return makeActivityLead({
      action,
      subject: genericSubject,
    });
  }
  return makeActivityLead({ action, subject: copy.detail });
}

function makeActivityLead(input: {
  readonly action: string;
  readonly subject: string;
  readonly context?: string;
  readonly monospace?: boolean;
}): ActivityLead {
  const action = compact(readableActivityText(input.action), 40);
  const readableSubject = input.monospace === true ? input.subject.trim() : readableActivityText(input.subject);
  const context = input.context === undefined
    ? undefined
    : readableActivityText(input.context);
  return {
    action: action.length === 0 ? "工具" : action,
    subject: readableSubject.length === 0 ? "工具活动" : readableSubject,
    ...(context === undefined || context.length === 0 ? {} : { context }),
    ...(input.monospace === true ? { monospace: true } : {}),
  };
}

function activityStatusBadge(node: ProjectableTranscriptNode): ActivityBadge | undefined {
  if (node.kind === "tool" && node.phase === "failed") {
    if (node.failureAttribution === "schema_validation") {
      return { label: "参数不符合工具要求", tone: "warning" };
    }
    if (node.failureAttribution === "execution_failure") {
      return { label: "工具执行失败", tone: "danger" };
    }
  }
  if (isContextCompactionNode(node)) {
    if (node.phase === "executing" || node.phase === "noted") return { label: "压缩中", tone: "accent" };
    if (node.phase === "completed") return { label: "压缩完成", tone: "success" };
    if (node.phase === "failed" || node.phase === "blocked") return { label: "压缩失败", tone: "danger" };
  }
  if (node.kind === "confirmation") {
    return { label: "待确认", tone: "warning" };
  }
  if (node.kind === "user_decision") {
    if (node.phase === "guidance") return { label: "已补充", tone: "accent" };
    if (node.phase === "denied") return { label: "已拒绝", tone: "danger" };
    if (node.phase === "approved") return { label: "已允许", tone: "success" };
    return undefined;
  }
  if (node.kind !== "tool") {
    if (node.phase === "failed" || node.phase === "blocked") return { label: "运行失败", tone: "danger" };
    if (node.phase === "cancelled") return { label: "已停止", tone: "warning" };
    return undefined;
  }
  return undefined;
}

function activityBadgesForNode(node: ProjectableTranscriptNode): readonly ActivityBadge[] | undefined {
  const display = node.display;
  if (isContextCompactionNode(node)) {
    return undefined;
  }
  const badges: ActivityBadge[] = [];
  if (display?.kind === "directory_listing" && (display.unreadableDirectories ?? 0) > 0) {
    badges.push({ label: "部分目录不可读", tone: "warning" });
  }
  if (display?.kind === "file_search_results" && (display.skippedUnreadableFiles ?? 0) > 0) {
    badges.push({ label: "部分文件不可读", tone: "warning" });
  }
  if (display?.kind === "http_response" && (display.statusCode ?? 0) >= 400) {
    badges.push({ label: "请求失败", tone: "danger" });
  }
  if (display?.truncated === true) {
    badges.push({ label: display.continuation === undefined ? "结果已截断" : "可继续读取", tone: "warning" });
  }
  return badges.length === 0 ? undefined : badges;
}

function activityVariantForNode(node: ProjectableTranscriptNode): ActivityItem["variant"] {
  if (isContextCompactionNode(node)) return "context_compaction";
  return undefined;
}

function isContextCompactionNode(node: ProjectableTranscriptNode): boolean {
  return node.eventType === "context.compaction.requested" ||
    node.eventType === "context.compaction.completed" ||
    node.eventType === "context.compaction.failed";
}

function isModelRequestNode(node: ProjectableTranscriptNode): boolean {
  return node.eventType === "model.requested";
}

function contextCompactionActivityCopy(node: ProjectableTranscriptNode): ActivityLineCopy {
  if (node.eventType === "context.compaction.requested" || node.phase === "executing") {
    return { detail: "正在上下文压缩" };
  }
  if (node.eventType === "context.compaction.completed") {
    return { detail: "上下文压缩完成" };
  }
  const detail = readableNarrationText(node.text ?? node.summary ?? "");
  return {
    detail: detail === undefined ? "上下文压缩失败" : `上下文压缩失败：${detail}`,
  };
}

function activityExpandedSectionsForNode(
  node: ProjectableTranscriptNode,
  copy: ActivityLineCopy,
): readonly ActivityExpandedSection[] | undefined {
  const display = node.display;
  const sections: ActivityExpandedSection[] = [];
  if (display?.kind === "command_summary") {
    const command = commandText(display);
    if (command !== undefined) {
      sections.push({
        title: "命令",
        content: `$ ${command}`,
        format: "console",
      });
    }
    const output = commandOutputForActivity(display);
    if (output !== undefined) {
      sections.push({
        title: "输出",
        content: output,
        format: "console",
        tone: stdoutMissingWithError(display) ? "danger" : undefined,
      });
    }
  } else if (display?.kind === "search_results") {
    const visibleResults = (display.results ?? []).slice(0, EXPANDED_SEARCH_RESULTS_LIMIT);
    const results = visibleResults.map((result) => searchResultLine(result.title, result.source, result.url));
    if (results.length > 0) {
      sections.push({
        title: "来源",
        content: results.join("\n"),
        format: "source_list",
        items: visibleResults.map(searchResultItem),
      });
    } else if (display.message !== undefined) {
      sections.push({ title: "提示", content: display.message });
    }
  } else if (display?.kind === "directory_listing") {
    const visibleEntries = display.entries.slice(0, EXPANDED_DIRECTORY_ENTRIES_LIMIT);
    const entries = visibleEntries.map(directoryEntryLine);
    if (entries.length > 0) {
      sections.push({
        title: "条目",
        content: entries.join("\n"),
        format: "path_list",
        items: visibleEntries.map(directoryEntryItem),
      });
    }
    const unreadable = display.unreadableSamples
      ?.slice(0, 6)
      .map((item) => [item.path, item.errorCode].filter((value): value is string => value !== undefined && value.length > 0).join(" · "))
      .filter((value) => value.length > 0);
    if ((unreadable?.length ?? 0) > 0) {
      sections.push({ title: "异常目录", content: unreadable!.join("\n"), format: "list", tone: "warning" });
    }
  } else if (display?.kind === "file_search_results") {
    const visibleMatches = display.matches.slice(0, EXPANDED_FILE_SEARCH_MATCHES_LIMIT);
    const matches = visibleMatches.map(fileSearchMatchLine);
    if (matches.length > 0) {
      sections.push({
        title: "匹配位置",
        content: matches.join("\n"),
        format: "path_list",
        items: visibleMatches.map(fileSearchMatchItem),
      });
    }
  } else if (display?.kind === "read_result") {
    const source = sourceSection("来源", {
      title: display.title ?? display.url ?? display.uri,
      url: display.url ?? urlLikeValue(display.uri),
    });
    if (source?.format === "source") {
      sections.push(source);
    }
    if (display.contentPreview !== undefined && source?.format !== "source") {
      sections.push({
        title: "内容",
        content: display.contentPreview,
        format: "code",
      });
    }
    if (display.error !== undefined) {
      sections.push({ title: "错误", content: display.error, tone: "danger" });
    }
  } else if (display?.kind === "web_fetch") {
    const source = sourceSection("来源", {
      title: display.title ?? display.url,
      url: display.url,
    });
    if (source !== undefined) {
      sections.push(source);
    }
  } else if (display?.kind === "http_response") {
    if (display.bodyPreview !== undefined) {
      sections.push({ title: "内容预览", content: display.bodyPreview, format: "code" });
    }
  } else if (display?.kind === "agent_task") {
    if (display.result !== undefined) {
      sections.push({ title: "结果", content: display.result });
    }
  } else if (display?.kind === "file_change_group") {
    const previewSections = display.files.flatMap((file) => {
      const preview = cleanFilePreviewContent(file.preview);
      if (preview === undefined) return [];
      return [{
        title: file.path,
        content: preview,
        format: filePreviewLooksLikeDiff(preview) ? "diff" as const : "code" as const,
      }];
    });
    if (previewSections.length > 0) {
      sections.push(...previewSections);
    } else {
      sections.push({
        title: "文件",
        content: display.files.map((file) => file.path).join("\n"),
        format: "path_list",
        items: display.files.map((file) => ({ title: file.path, monospace: true })),
      });
    }
  } else if (display?.kind === "file_change_summary" || display?.kind === "file_diff_preview") {
    const preview = filePreviewContentForActivity(display, node, copy);
    if (preview !== undefined) {
      sections.push({
        title: filePreviewSectionTitle(display),
        content: preview,
        format: display.kind === "file_diff_preview" || filePreviewLooksLikeDiff(preview) ? "diff" : "code",
      });
    } else if (node.phase !== "completed") {
      const changeSummary = fileChangeSummary(display);
      if (changeSummary !== undefined) {
        sections.push({
          title: "变更",
          content: changeSummary,
          tone: fileOperationTone(fileDisplayOperation(display)),
        });
      }
    }
  } else if (display?.kind === "generic_tool_summary" || display?.kind === "raw_tool_result") {
    sections.push(...genericToolSections(display, copy));
  }
  if (node.delegatedExecution !== undefined) {
    const usage = node.delegatedExecution.usage;
    const totalTokens = usage.totalTokens;
    const inputTokens = usage.inputTokens;
    const outputTokens = usage.outputTokens;
    const tokenSummary = totalTokens === undefined
      ? "未报告"
      : `${totalTokens}（输入 ${inputTokens ?? 0}，输出 ${outputTokens ?? 0}）`;
    sections.push({
      title: "执行统计",
      content: `模型轮次：${node.delegatedExecution.modelRounds}\n工具调用：${node.delegatedExecution.toolCallCount}\nToken：${tokenSummary}`,
      format: "plain",
    });
  }
  if (node.error !== undefined) {
    sections.push({ title: "错误", content: node.error, format: "diagnostics", tone: "danger" });
  }
  const fallback = copy.expandedDetail === undefined ? [] : [{ title: "详情", content: copy.expandedDetail }];
  const allSections = dedupeExpandedSections(appendSectionsWithoutDuplicateContent(sections, fallback));
  return allSections.length === 0 ? undefined : allSections;
}

function commandOutputForActivity(
  display: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "command_summary" }>,
): string | undefined {
  const stdout = display.stdoutPreview;
  const stderr = display.stderrPreview;
  const parts = [stdout, stderr].filter((value): value is string => value !== undefined && value.length > 0);
  return parts.length === 0 ? undefined : parts.join("\n");
}

function stdoutMissingWithError(
  display: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "command_summary" }>,
): boolean {
  return display.stdoutPreview === undefined &&
    display.stderrPreview !== undefined;
}

function toolCallIdForActivityNode(node: ProjectableTranscriptNode): string | undefined {
  return node.refs.find((item) => item.kind === "tool_call")?.id;
}

function isTerminalToolNode(node: ProjectableTranscriptNode): boolean {
  return node.eventType === "tool.completed" || node.eventType === "tool.failed" || node.eventType === "tool.cancelled";
}

function mergeToolActivityItems(requested: ActivityItem, terminal: ActivityItem): ActivityItem {
  const sections = buildExpandedSections(requested, terminal);
  const expandedDetail = mergedToolExpandedDetail(terminal.copy, terminal.phase);
  return {
    ...terminal,
    key: requested.key,
    copy: {
      ...terminal.copy,
      expandedDetail,
    },
    toolKind: terminal.toolKind ?? resolveActivityToolKind(terminal),
    lineDelta: terminal.lineDelta ?? requested.lineDelta,
    expandedSections: sections.length > 0
      ? sections
      : expandedDetail === undefined
        ? undefined
        : fallbackExpandedSections({ ...terminal.copy, expandedDetail }),
  };
}

function buildExpandedSections(
  requested: ActivityItem,
  terminal: ActivityItem,
): readonly ActivityExpandedSection[] {
  const terminalSections = terminal.expandedSections ?? fallbackExpandedSections(terminal.copy);
  if (terminal.phase === "completed") {
    const sections = terminalSections.length > 0
      ? terminalSections
      : completedPayloadFallbackSections(requested);
    return dedupeExpandedSections(sections);
  }
  return dedupeExpandedSections(terminalSections);
}

function completedPayloadFallbackSections(item: ActivityItem): readonly ActivityExpandedSection[] {
  if (item.toolKind !== "edit") {
    return [];
  }
  const sections = item.expandedSections ?? fallbackExpandedSections(item.copy);
  return sections.filter((section) => section.format === "diff" || section.format === "code");
}

function mergedToolExpandedDetail(
  terminal: ActivityLineCopy,
  phase: ProjectableTranscriptNode["phase"]
): string | undefined {
  if (phase === "completed") {
    return terminal.expandedDetail;
  }
  return terminal.expandedDetail;
}

function fallbackExpandedSections(copy: ActivityLineCopy): readonly ActivityExpandedSection[] {
  return copy.expandedDetail === undefined ? [] : [{ title: "详情", content: copy.expandedDetail }];
}

function dedupeExpandedSections(sections: readonly ActivityExpandedSection[]): readonly ActivityExpandedSection[] {
  const seen = new Set<string>();
  const result: ActivityExpandedSection[] = [];
  for (const section of sections) {
    const title = section.title.trim();
    const content = section.content.trim();
    if (title.length === 0 || content.length === 0) {
      continue;
    }
    const key = `${title}\u0000${content}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ ...section, title, content });
  }
  return result;
}

function appendSectionsWithoutDuplicateContent(
  base: readonly ActivityExpandedSection[],
  incoming: readonly ActivityExpandedSection[],
): readonly ActivityExpandedSection[] {
  const seenContent = new Set(base.map((section) => section.content.trim()).filter((value) => value.length > 0));
  const result = [...base];
  for (const section of incoming) {
    const content = section.content.trim();
    if (content.length > 0 && seenContent.has(content) && section.title.trim() !== "文件") {
      continue;
    }
    if (content.length > 0) {
      seenContent.add(content);
    }
    result.push(section);
  }
  return result;
}

function readableConfirmationCopy(node: ProjectableTranscriptNode): ActivityLineCopy {
  const action = cleanConfirmationSummary(node.confirmation?.actionSummary ?? node.summary ?? "");
  if (action.length === 0) {
    return { label: "待处理", detail: "等待你判断。" };
  }
  const detail = compact(readableActivityText(action), 180);
  return detail === action ? { label: "待处理", detail } : { label: "待处理", detail, expandedDetail: action };
}

function readableUserDecisionCopy(node: ProjectableTranscriptNode): ActivityLineCopy | undefined {
  if (node.phase === "approved") {
    return undefined;
  }
  const fallback = userDecisionFallback(node.phase);
  const raw = cleanConfirmationSummary(node.text ?? node.summary ?? "");
  const detail = readableActivityText(stripUserDecisionBoilerplate(stripMarkdownStructure(raw)));
  if (detail.length === 0) {
    return fallback === undefined ? undefined : { detail: fallback };
  }
  if (isGenericApprovalDecisionText(detail)) {
    return fallback === undefined ? undefined : { detail: fallback };
  }
  const compactDetail = compact(detail, 180);
  return compactDetail === detail
    ? { detail }
    : { detail: compactDetail, expandedDetail: detail };
}

function userDecisionFallback(phase: ProjectableTranscriptNode["phase"]): string | undefined {
  if (phase === "denied") return "已不执行。";
  if (phase === "guidance") return "已补充要求。";
  return undefined;
}

function stripUserDecisionBoilerplate(value: string): string {
  return value
    .replace(/^已收到补充(?:指导|要求)[:：]?\s*/u, "")
    .replace(/^已补充(?:指导|要求)[:：]?\s*/u, "")
    .replace(/^用户(?:已)?补充(?:指导|要求)[:：]?\s*/u, "")
    .trim();
}

export function readableThinkingText(value: string): string | undefined {
  const text = readableModelActivityText(value);
  if (text.length === 0) return undefined;
  return compact(takeNaturalSentences(text, 2), 180);
}

export function readableThinkingCopy(value: string): ActivityLineCopy | undefined {
  const expandedDetail = readableExpandedModelText(value);
  if (expandedDetail.length === 0) return undefined;
  return {
    detail: "思考中",
    expandedDetail,
  };
}

export function readableNarrationText(value: string): string | undefined {
  const candidate = narrationCandidate(value);
  if (candidate === undefined) return undefined;
  const text = readableActivityText(candidate);
  if (text.length === 0) return undefined;
  return compact(takeNaturalSentences(text, 2), 180);
}

export function readableNarrationCopy(value: string): ActivityLineCopy | undefined {
  const candidate = narrationCandidate(value);
  if (candidate === undefined) return undefined;
  const expandedDetail = readableModelActivityText(candidate);
  if (expandedDetail.length === 0) return undefined;
  const detail = compact(takeNaturalSentences(expandedDetail, 2), 180);
  return copyWithNonRepeatingExpandedDetail(detail, expandedDetail);
}

function copyWithNonRepeatingExpandedDetail(detail: string, expandedDetail: string): ActivityLineCopy {
  const rest = nonRepeatingExpandedDetail(detail, expandedDetail);
  return rest === undefined ? { detail } : { detail, expandedDetail: rest };
}

function nonRepeatingExpandedDetail(detail: string, expandedDetail: string): string | undefined {
  const expanded = expandedDetail.replace(/\s+/g, " ").trim();
  const prefix = detail.replace(/…$/, "").replace(/\s+/g, " ").trim();
  if (expanded.length === 0 || prefix.length === 0) return undefined;
  if (expanded === prefix) return undefined;
  if (detail.endsWith("…") && prefix.length < expanded.length) {
    return cleanExpandedRemainder(expanded.slice(prefix.length), true);
  }
  if (!expanded.startsWith(prefix)) return expanded;
  return cleanExpandedRemainder(expanded.slice(prefix.length), false);
}

function cleanExpandedRemainder(value: string, dropPartialSentence: boolean): string | undefined {
  let rest = value
    .replace(/^[\s,;:，；：、。.!?？!-]+/u, "")
    .trim();
  if (dropPartialSentence && shouldDropPartialSentence(rest)) {
    const boundary = rest.search(/[。！？!?\.]\s+/u);
    if (boundary >= 0) {
      rest = rest.slice(boundary + 1).trim();
    }
  }
  return rest.length === 0 ? undefined : rest;
}

function shouldDropPartialSentence(value: string): boolean {
  const first = value.trim()[0];
  return first !== undefined && /[a-z0-9]/u.test(first);
}

function directoryEntryLine(
  entry: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "directory_listing" }>["entries"][number],
): string {
  return directoryEntryTitle(entry);
}

function directoryEntryItem(
  entry: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "directory_listing" }>["entries"][number],
): ActivityExpandedItem {
  return {
    title: directoryEntryTitle(entry),
    monospace: true,
  };
}

function directoryEntryTitle(
  entry: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "directory_listing" }>["entries"][number],
): string {
  return entry.kind === "directory" && !entry.path.endsWith("/")
    ? `${entry.path}/`
    : entry.path;
}

function searchResultItem(
  result: NonNullable<Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "search_results" }>["results"]>[number],
): ActivityExpandedItem {
  const source = compactHostLabel(result.url) ?? result.source;
  return {
    title: result.title,
    href: result.url,
    meta: source === undefined ? undefined : [{ value: source }],
  };
}

function searchResultsReturned(
  display: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "search_results" }>,
): number {
  return display.results.length;
}

function fileSearchMatchesReturned(
  display: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "file_search_results" }>,
): number {
  return display.matches.length;
}

function directoryListingHeadline(
  display: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "directory_listing" }>,
): string {
  return toolPathLabel(display.path) ?? "目录内容";
}

function fileSearchHeadline(
  display: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "file_search_results" }>,
): string {
  return cleanToolTargetText(display.query) ??
    toolPathLabel(display.path) ??
    "项目内容";
}

function toolPathLabel(value: string | undefined): string | undefined {
  if (value === ".") {
    return "当前目录";
  }
  return cleanToolTargetText(value);
}

function fileSearchMatchLine(
  match: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "file_search_results" }>["matches"][number],
): string {
  const location = match.line === undefined ? match.path : `${match.path}:${match.line}`;
  return match.preview === undefined || match.preview.trim().length === 0
    ? location
    : `${location} - ${match.preview.trim()}`;
}

function fileSearchMatchItem(
  match: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "file_search_results" }>["matches"][number],
): ActivityExpandedItem {
  return {
    title: match.line === undefined ? match.path : `${match.path}:${match.line}`,
    detail: cleanToolTargetText(match.preview),
    monospace: true,
  };
}

type FileDisplay = Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "file_change_summary" | "file_diff_preview" }>;

type FileDisplayOperation = NonNullable<FileDisplay["operation"]>;

function fileDisplayOperation(display: FileDisplay): FileDisplayOperation | undefined {
  if (display.operation !== undefined) {
    return display.operation;
  }
  if (display.kind === "file_diff_preview") {
    return "edit";
  }
  return undefined;
}

function fileOperationTone(operation: FileDisplayOperation | undefined): ActivityBadge["tone"] | undefined {
  if (operation === "create") return "success";
  if (operation === "delete") return "danger";
  if (operation === "append") return "accent";
  if (operation === "edit" || operation === "write") return "warning";
  return undefined;
}

function fileChangeSummary(display: FileDisplay): string | undefined {
  const operation = fileDisplayOperation(display);
  return operation === undefined ? undefined : `${fileOperationSentence(operation)}。`;
}

function fileOperationSentence(operation: FileDisplayOperation): string {
  if (operation === "create") return "已新增文件";
  if (operation === "append") return "已追加内容";
  if (operation === "delete") return "已删除文件";
  if (operation === "edit") return "已编辑文件";
  return "已写入文件";
}

function filePreviewSectionTitle(display: FileDisplay): string {
  if (display.kind === "file_diff_preview") {
    return "差异预览";
  }
  const operation = fileDisplayOperation(display);
  if (operation === "create") return "新增内容";
  if (operation === "append") return "追加内容";
  if (operation === "write") return "写入内容";
  return "内容预览";
}

function filePreviewContentForActivity(
  display: FileDisplay,
  node: ProjectableTranscriptNode,
  copy: ActivityLineCopy,
): string | undefined {
  return cleanFilePreviewContent(display.preview) ??
    cleanFilePreviewContent(copy.expandedDetail) ??
    cleanFilePreviewContent(node.summary);
}

function cleanFilePreviewContent(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const cleaned = value
    .replace(/^变更预览\s*$/gmu, "")
    .replace(/^替换[:：]\s*\d+\s*处\s*$/gmu, "")
    .trim();
  return cleaned.length === 0 ? undefined : cleaned;
}

function activityLineDeltaForNode(
  node: ProjectableTranscriptNode,
  copy: ActivityLineCopy,
): ActivityLineDelta | undefined {
  const display = node.display;
  const previews = display?.kind === "file_change_group"
    ? display.files.map((file) => file.preview)
    : display?.kind === "file_change_summary" || display?.kind === "file_diff_preview"
      ? [filePreviewContentForActivity(display, node, copy)]
      : [];
  return mergeLineDeltas(previews.map((preview) => lineDeltaFromDiffPreview(preview)));
}

function mergeLineDeltas(deltas: readonly (ActivityLineDelta | undefined)[]): ActivityLineDelta | undefined {
  let added = 0;
  let removed = 0;
  for (const delta of deltas) {
    if (delta !== undefined) {
      added += delta.added;
      removed += delta.removed;
    }
  }
  return added === 0 && removed === 0 ? undefined : { added, removed };
}

function lineDeltaFromDiffPreview(preview: string | undefined): ActivityLineDelta | undefined {
  if (preview === undefined) {
    return undefined;
  }
  const lines = preview.replace(/\r\n?/g, "\n").split("\n");
  const hasHunks = lines.some((line) => line.startsWith("@@"));
  let insideHunk = !hasHunks;
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith("diff --git ") || line.startsWith("Index: ")) {
      insideHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      insideHunk = true;
      continue;
    }
    if (!insideHunk) {
      continue;
    }
    if (!hasHunks && (line.startsWith("+++ ") || line.startsWith("--- "))) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return added === 0 && removed === 0 ? undefined : { added, removed };
}

function filePreviewLooksLikeDiff(value: string): boolean {
  return value
    .split("\n")
    .some((line) => line.startsWith("+") || line.startsWith("-") || line.startsWith("@@"));
}

type GenericToolSummaryDisplay = Extract<
  NonNullable<ProjectableTranscriptNode["display"]>,
  { readonly kind: "generic_tool_summary" | "raw_tool_result" }
>;

type GenericArticleFacts = {
  readonly title?: string;
  readonly url?: string;
  readonly published?: string;
  readonly author?: string;
  readonly excerpt?: string;
};

function genericToolRole(
  toolName: string,
  display: GenericToolSummaryDisplay,
): "网页" | "搜索" | "读取" | "查看" | "命令" | undefined {
  const text = genericToolJoinedText(display).toLowerCase();
  const action = display.action?.toLowerCase() ?? "";
  if (
    action.includes("搜索") ||
    action.includes("检索") ||
    action.includes("查询") ||
    action.includes("查找") ||
    action.includes("search") ||
    action.includes("lookup") ||
    action.includes("find") ||
    action.includes("query") ||
    toolName.includes("search") ||
    toolName.includes("lookup") ||
    toolName.includes("find") ||
    toolName.includes("query")
  ) {
    return "搜索";
  }
  if (
    action.includes("命令") ||
    action.includes("shell") ||
    toolName.includes("command")
  ) {
    return "命令";
  }
  if (
    action.includes("列出") ||
    action.includes("目录") ||
    action.includes("list") ||
    toolName.includes("list") ||
    toolName.includes("dir")
  ) {
    return "查看";
  }
  if (
    action.includes("浏览") ||
    action.includes("网页") ||
    action.includes("browser") ||
    action.includes("web") ||
    text.includes("url: http") ||
    /^https?:\/\//u.test(text.trim())
  ) {
    return "网页";
  }
  if (
    action.includes("读取") ||
    action.includes("read") ||
    toolName.startsWith("read") ||
    (text.includes("title:") && text.includes("published:"))
  ) {
    return "读取";
  }
  return undefined;
}

function genericToolSections(
  display: GenericToolSummaryDisplay,
  copy: ActivityLineCopy,
): readonly ActivityExpandedSection[] {
  const directory = genericDirectoryFacts(display);
  if (directory !== undefined) {
    const sections: ActivityExpandedSection[] = [];
    if (directory.items.length > 0) {
      sections.push({
        title: "条目",
        content: directory.items.join("\n"),
        format: "path_list",
        items: directory.items.map((title) => ({ title, monospace: true })),
      });
    }
    return sections;
  }

  const article = display.kind === "raw_tool_result" ? {} : genericArticleFacts(display);
  const sections: ActivityExpandedSection[] = [];
  if (article.title !== undefined || article.url !== undefined || article.published !== undefined || article.author !== undefined) {
    const source = sourceSection("来源", {
      title: article.title ?? article.url,
      url: article.url,
    });
    if (source !== undefined) {
      sections.push(source);
    }
  }
  const summary = cleanGenericSummaryText(display.summary);
  if (
    summary !== undefined &&
    article.excerpt === undefined &&
    !genericTextMatchesArticle(summary, article) &&
    !genericTextAlreadyRepresented(summary, sections, copy)
  ) {
    sections.push({ title: "内容", content: summary });
  }

  const items = uniqueStrings(
    (display.items ?? [])
      .map((item) => cleanGenericSummaryText(genericItemLabel(item)) ?? "")
      .filter((value) => value.length > 0)
      .filter((value) => !genericTextMatchesArticle(value, article))
      .filter((value) => !genericTextAlreadyRepresented(value, sections, copy))
  );
  if (items.length > 0) {
    sections.push({ title: "条目", content: items.join("\n"), format: "list" });
  }
  return sections;
}

function genericArticleFacts(display: GenericToolSummaryDisplay): GenericArticleFacts {
  const text = genericToolJoinedText(display);
  const title = fieldValue(text, "Title");
  const url = fieldValue(text, "URL");
  const published = fieldValue(text, "Published");
  const author = fieldValue(text, "Author");
  const hasArticleIdentity = title !== undefined || url !== undefined || published !== undefined || author !== undefined;
  return {
    title,
    url,
    published,
    author,
    excerpt: hasArticleIdentity ? articleExcerpt(text, title) : undefined,
  };
}

function genericToolJoinedText(display: GenericToolSummaryDisplay): string {
  return uniqueStrings([
    display.summary,
    ...(display.items ?? []).map(genericItemLabel),
  ].filter((value): value is string => value !== undefined && value.trim().length > 0)).join("\n");
}

type GenericDirectoryFacts = {
  readonly path?: string;
  readonly count?: number;
  readonly depth?: number;
  readonly items: readonly string[];
};

function genericDirectoryFacts(display: GenericToolSummaryDisplay): GenericDirectoryFacts | undefined {
  if (display.kind === "raw_tool_result") return undefined;
  const action = display.action?.toLowerCase() ?? "";
  const text = genericToolJoinedText(display).toLowerCase();
  const looksLikeDirectory =
    action.includes("目录") ||
    action.includes("list") ||
    action.includes("dir") ||
    text.includes("entries") ||
    text.includes("depth=");
  if (!looksLikeDirectory) {
    return undefined;
  }
  const summary = display.summary ?? "";
  const count = genericDirectoryCount(summary);
  const depth = genericDirectoryDepth(summary) ?? genericDirectoryDepth(display.items?.join(" ") ?? "");
  const path = genericDirectoryPath(summary);
  const items = uniqueStrings(
    (display.items ?? [])
      .map(genericDirectoryItemLabel)
      .filter((item): item is string => item !== undefined && item.length > 0)
  );
  if (count === undefined && path === undefined && depth === undefined && items.length === 0) {
    return undefined;
  }
  return { path, count, depth, items };
}

function genericDirectoryHeadline(display: GenericToolSummaryDisplay): string | undefined {
  const facts = genericDirectoryFacts(display);
  if (facts === undefined) {
    return undefined;
  }
  return toolPathLabel(facts.path) ?? "目录内容";
}

function genericDirectoryPath(summary: string): string | undefined {
  const first = summary.split(/[·\n]/u)[0]?.trim();
  if (first === undefined || first.length === 0 || /\d+\s*(?:entries|项)/iu.test(first)) {
    return undefined;
  }
  if (first === ".") {
    return first;
  }
  return cleanToolTargetText(first);
}

function genericDirectoryCount(summary: string): number | undefined {
  const match = /(?:^|[^\d])(\d+)\s*(?:of\s+\d+\s*)?(?:entries|entry|项)\b/iu.exec(summary);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const count = Number.parseInt(match[1], 10);
  return Number.isFinite(count) ? count : undefined;
}

function genericDirectoryDepth(value: string): number | undefined {
  const match = /\bdepth\s*=?\s*(\d+)\b/iu.exec(value);
  if (match?.[1] === undefined) {
    return undefined;
  }
  const depth = Number.parseInt(match[1], 10);
  return Number.isFinite(depth) ? depth : undefined;
}

function genericDirectoryItemLabel(value: string): string | undefined {
  const withoutPrefix = genericItemLabel(value)
    .replace(/\s+depth\s*=?\s*\d+\b/giu, "")
    .replace(/\s+\[truncated\]\s*$/iu, "")
    .trim();
  if (
    withoutPrefix.length === 0 ||
    withoutPrefix === "[truncated]" ||
    /\b\d+\s*(?:entries|entry|项)\b/iu.test(withoutPrefix)
  ) {
    return undefined;
  }
  return withoutPrefix;
}

function fieldValue(text: string, field: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\n)\\s*${field}\\s*:\\s*(.+?)(?=\\n\\s*(?:Title|URL|Published|Author|Highlights?)\\s*:|$)`, "isu");
  const value = pattern.exec(text)?.[1]?.trim();
  return value === undefined || value.length === 0 ? undefined : value.replace(/\s+/g, " ");
}

function articleExcerpt(text: string, title: string | undefined): string | undefined {
  const withoutFields = text
    .replace(/(?:^|\n)\s*(?:Title|URL|Published|Author)\s*:\s*.+?(?=\n\s*(?:Title|URL|Published|Author|Highlights?)\s*:|\n#|\n{2,}|$)/gis, "\n")
    .replace(/(?:^|\n)\s*Highlights?\s*:\s*/giu, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const lines = withoutFields
    .split("\n")
    .map((line) => stripMarkdownLinePrefix(line.trim()))
    .map((line) => stripArticleTitlePrefix(line, title))
    .filter((line): line is string => line !== undefined && line.length > 0 && !isMarkdownDivider(line));
  const uniqueLines = uniqueByNormalizedContent(lines);
  const excerpt = uniqueLines.join("\n").trim();
  return excerpt.length === 0 ? undefined : compact(excerpt, 700);
}

function stripArticleTitlePrefix(line: string, title: string | undefined): string | undefined {
  if (title === undefined || title.trim().length === 0) {
    return line;
  }
  const trimmed = line.trim();
  for (const variant of articleTitleVariants(title)) {
    const normalizedVariant = variant.toLowerCase();
    const normalizedLine = trimmed.toLowerCase();
    if (normalizedLine === normalizedVariant) {
      return undefined;
    }
    if (normalizedLine.startsWith(normalizedVariant)) {
      const rest = trimmed
        .slice(variant.length)
        .replace(/^[\s:：|·\-–—.。,…]+/u, "")
        .trim();
      return rest.length === 0 ? undefined : rest;
    }
  }
  return line;
}

function articleTitleVariants(title: string): readonly string[] {
  return uniqueStrings([
    title,
    title.split("|")[0],
    title.split(" - ")[0],
    title.split(" — ")[0],
    title.split(" – ")[0],
  ].map((value) => value?.trim() ?? "").filter((value) => value.length > 0));
}

function uniqueByNormalizedContent(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeSectionContent(value);
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(value.trim());
  }
  return result;
}

function sourceSection(
  title: string,
  input: {
    readonly title?: string;
    readonly url?: string;
  },
): ActivityExpandedSection | undefined {
  const content = cleanToolTargetText(input.title) ?? cleanToolTargetText(input.url);
  if (content === undefined) {
    return undefined;
  }
  const href = httpHref(input.url);
  return {
    title,
    content,
    format: href === undefined ? "plain" : "source",
    href,
  };
}

function urlLikeValue(value: string | undefined): string | undefined {
  return httpHref(value);
}

function httpHref(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function cleanGenericSummaryText(value: string | undefined): string | undefined {
  const cleaned = cleanToolTargetText(value);
  if (cleaned === undefined) return undefined;
  return cleaned
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function genericTextAlreadyRepresented(
  value: string,
  sections: readonly ActivityExpandedSection[],
  copy: ActivityLineCopy,
): boolean {
  const normalized = normalizeSectionContent(value);
  if (normalized.length === 0) return true;
  if (normalizeSectionContent(copy.detail) === normalized) return true;
  return sections.some((section) => {
    const content = normalizeSectionContent(section.content);
    return content === normalized || content.includes(normalized) || normalized.includes(content);
  });
}

function genericTextMatchesArticle(value: string, article: GenericArticleFacts): boolean {
  const normalized = normalizeSectionContent(value);
  if (normalized.length === 0) return true;
  const title = article.title === undefined ? undefined : normalizeSectionContent(article.title);
  const url = article.url === undefined ? undefined : normalizeSectionContent(article.url);
  const excerpt = article.excerpt === undefined ? undefined : normalizeSectionContent(article.excerpt);
  return (title !== undefined && normalized.includes(title) && (url === undefined || normalized.includes(url))) ||
    (excerpt !== undefined && excerpt.length > 0 && normalized.includes(excerpt));
}

function normalizeSectionContent(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[。.!！?？；;:：、，,\s]/g, "")
    .trim()
    .toLowerCase();
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function toolVerb(node: ProjectableTranscriptNode): string {
  const display = node.display;
  const toolName = normalizedToolName(node.toolName);
  const action = display?.kind === "generic_tool_summary" || display?.kind === "raw_tool_result"
    ? display.action?.toLowerCase() ?? ""
    : "";
  if (display?.kind === "knowledge_operation") {
    if (display.operation === "search") return "搜索";
    if (display.operation === "read") return "读取";
    return "知识";
  }
  if (display?.kind === "space_operation") {
    if (display.operation === "list") return "查看";
    return "空间";
  }
  if (display?.kind === "note_operation") return "记录";
  const fileMutationVerb = fileMutationVerbForTool(toolName, display);
  if (display?.kind === "agent_task" || toolName === "agent" || toolName === "agentspawn") return "委派";
  if (display?.kind === "command_summary" || toolName === "shell" || toolName.includes("terminal") || toolName.includes("powershell") || toolName.includes("cmd")) return "命令";
  if (display?.kind === "search_results" || toolName === "researchsearch" || toolName === "websearch" || toolName.includes("grep")) return "搜索";
  if (display?.kind === "file_search_results") return "搜索";
  if (display?.kind === "directory_listing") return "查看";
  if (display?.kind === "http_response" || toolName === "httprequest") return "请求";
  if (fileMutationVerb !== undefined) return fileMutationVerb;
  if (display?.kind === "generic_tool_summary") {
    const role = genericToolRole(toolName, display);
    if (role !== undefined) return role;
  }
  if (display?.kind === "read_result") return "读取";
  if (display?.kind === "web_fetch" || toolName === "webfetch" || toolName.includes("browser")) return "网页";
  if (toolName === "list" || toolName === "list_files" || toolName.includes("list") || toolName.includes("dir")) return "查看";
  if (toolName === "read" || toolName === "researchread" || toolName.startsWith("read") || toolName.includes("file")) return "读取";
  if (action.includes("读取")) return "读取";
  if (action.includes("搜索") || action.includes("查找")) return "搜索";
  if (action.includes("浏览")) return "网页";
  if (action.includes("列出")) return "查看";
  if (action.includes("命令") || action.includes("shell") || action.includes("执行")) return "命令";
  if (action.includes("写入")) return "写入";
  if (action.includes("编辑") || action.includes("修改")) return "编辑";
  if (action.includes("删除")) return "删除";
  if (toolName.includes("generate") || action.includes("生成")) return "生成";
  return "动作";
}

function fileMutationVerbForTool(
  toolName: string,
  display: ProjectableTranscriptNode["display"],
): "写入" | "创建" | "删除" | "编辑" | undefined {
  if (display?.kind === "file_change_group") {
    const operations = uniqueStrings(
      display.files
        .map((file) => file.operation)
        .filter((operation): operation is NonNullable<typeof operation> => operation !== undefined),
    );
    if (operations.length === 1) {
      const operation = operations[0];
      if (operation === "create") return "创建";
      if (operation === "delete") return "删除";
      if (operation === "append" || operation === "write") return "写入";
    }
    return "编辑";
  }
  if (display?.kind === "file_change_summary" || display?.kind === "file_diff_preview") {
    const operation = fileDisplayOperation(display);
    if (operation === "create") return "创建";
    if (operation === "delete") return "删除";
    if (operation === "edit") return "编辑";
    if (operation === "append" || operation === "write") return "写入";
  }
  if (display !== undefined) return undefined;
  if (toolName === "delete" || toolName.includes("delete") || toolName.includes("remove_file")) {
    return "删除";
  }
  if (toolName === "create" || toolName.includes("create")) {
    return "创建";
  }
  if (
    toolName === "edit" ||
    toolName.includes("edit") ||
    toolName.includes("patch") ||
    toolName.includes("replace")
  ) {
    return "编辑";
  }
  if (toolName === "write" || toolName.includes("write")) {
    return "写入";
  }
  return undefined;
}

function toolTargetCopy(node: ProjectableTranscriptNode): Pick<ActivityLineCopy, "detail" | "expandedDetail"> | undefined {
  const display = node.display;
  if (display?.kind === "command_summary") {
    return { detail: "终端" };
  }
  if (display?.kind === "search_results") {
    const query = cleanToolTargetText(display.query);
    if (query !== undefined) {
      return readableToolTarget(query);
    }
    const message = cleanToolTargetText(display.message);
    if ((node.phase === "failed" || node.phase === "blocked") && message !== undefined) {
      return readableToolTarget(message);
    }
    const firstResult = display.results
      ?.map((result) => cleanToolTargetText(result.title) ?? cleanToolTargetText(result.source) ?? cleanToolTargetText(result.url))
      .find((result): result is string => result !== undefined);
    if (firstResult !== undefined) {
      return readableToolTarget(firstResult);
    }
    return {
      detail: searchResultsReturned(display) > 0 ? "网页资料" : "未找到相关内容",
    };
  }
  if (display?.kind === "directory_listing") {
    return {
      detail: readableActivityText(directoryListingHeadline(display)),
    };
  }
  if (display?.kind === "file_search_results") {
    return {
      detail: readableActivityText(fileSearchHeadline(display)),
    };
  }
  if (display?.kind === "read_result") {
    return readableToolTarget(readResultTarget(display, node.summary)) ?? fallbackToolTargetCopy(node);
  }
  if (display?.kind === "web_fetch") {
    return readableToolTarget(cleanToolTargetText(display.title ?? display.url ?? node.summary)) ?? fallbackToolTargetCopy(node);
  }
  if (display?.kind === "http_response") {
    const target = [
      display.method,
      display.url,
    ].filter((value): value is string => value !== undefined && value.trim().length > 0).join(" ");
    return readableToolTarget(cleanToolTargetText(target || node.summary)) ?? fallbackToolTargetCopy(node);
  }
  if (display?.kind === "agent_task") {
    return {
      detail: cleanToolTargetText(display.agentName) ?? cleanToolTargetText(display.task) ?? "协作任务",
    };
  }
  if (display?.kind === "knowledge_operation") {
    const target = display.query ?? display.title ?? display.noteId ?? display.spaceId;
    return { detail: cleanToolTargetText(target) ?? "个人知识" };
  }
  if (display?.kind === "space_operation") {
    const target = display.title ?? display.spaceId ?? display.targetId;
    return { detail: cleanToolTargetText(target) ?? "空间" };
  }
  if (display?.kind === "note_operation") {
    return { detail: display.scope === "global" ? "全局笔记" : display.scope === "workspace" ? "工作区笔记" : "Agent 笔记" };
  }
  if (display?.kind === "file_change_summary" || display?.kind === "file_diff_preview") {
    return readableToolTarget(cleanToolTargetText(display.path ?? node.summary)) ?? fallbackToolTargetCopy(node);
  }
  if (display?.kind === "file_change_group") {
    return { detail: `${display.files.length} 个文件` };
  }
  if (display?.kind === "generic_tool_summary") {
    const role = genericToolRole(normalizedToolName(node.toolName), display);
    if (role === "命令") {
      return { detail: "终端" };
    }
    if (role === "搜索") {
      const target = cleanToolTargetText(display.summary) ??
        display.items
          ?.map((item) => cleanToolTargetText(genericItemLabel(item)))
          .find((item): item is string => item !== undefined);
      if (target !== undefined) {
        return readableToolTarget(target);
      }
      return { detail: genericSearchActivityHeadline(node.phase) };
    }
    const directoryHeadline = genericDirectoryHeadline(display);
    if (directoryHeadline !== undefined) {
      return {
        detail: readableActivityText(directoryHeadline),
      };
    }
    const article = genericArticleFacts(display);
    if (article.title !== undefined || article.url !== undefined) {
      return readableToolTarget(article.title ?? compactHostLabel(article.url));
    }
    const items = display.items
      ?.map((item) => cleanToolTargetText(genericItemLabel(item)) ?? "")
      .filter((value) => value.length > 0) ?? [];
    const summary = cleanToolTargetText(display.summary ?? node.summary);
    if (summary !== undefined && items.length > 1) {
      return {
        detail: readableActivityText(summary),
        expandedDetail: items.join("\n"),
      };
    }
    if (items.length === 1) return readableToolTarget(items[0]);
    if (items.length > 1) {
      return {
        detail: isFileReadNode(node) ? `${items.length} 个文件` : `${items.length} 项`,
        expandedDetail: items.join("\n"),
      };
    }
    return readableToolTarget(summary ?? genericActionTargetText(display.action)) ?? fallbackToolTargetCopy(node);
  }
  return readableToolTarget(cleanToolTargetText(node.summary)) ?? fallbackToolTargetCopy(node);
}

function genericSearchActivityHeadline(phase: ProjectableTranscriptNode["phase"]): string {
  if (phase === "failed" || phase === "blocked") return "搜索失败";
  if (phase === "cancelled") return "搜索已停止";
  if (phase === "preparing" || phase === "executing" || phase === "noted") return "正在搜索";
  return "未找到相关内容";
}

function toolStatusText(node: ProjectableTranscriptNode): string | undefined {
  if (node.phase === "failed") return "动作失败";
  return undefined;
}

function fallbackToolTargetCopy(node: ProjectableTranscriptNode): Pick<ActivityLineCopy, "detail" | "expandedDetail"> | undefined {
  return readableToolTarget(fallbackToolTargetText(node));
}

function fallbackToolTargetText(node: ProjectableTranscriptNode): string | undefined {
  const display = node.display;
  if (display?.kind === "command_summary") {
    return cleanToolTargetText(display.stderrPreview) ??
      cleanToolTargetText(display.stdoutPreview) ??
      fallbackToolActionText(node);
  }
  if (display?.kind === "search_results") {
    const firstResult = display.results
      ?.map((result) => cleanToolTargetText(result.title) ?? cleanToolTargetText(result.source) ?? cleanToolTargetText(result.url))
      .find((value): value is string => value !== undefined && value.length > 0);
    return firstResult ??
      (searchResultsReturned(display) > 0 ? `${searchResultsReturned(display)} 条结果` : undefined) ??
      fallbackToolActionText(node);
  }
  if (display?.kind === "read_result") {
    return cleanToolTargetText(display.error) ??
      previewLineTarget(display.contentPreview) ??
      cleanToolTargetText(display.title ?? display.url ?? display.uri) ??
      fallbackToolActionText(node);
  }
  if (display?.kind === "web_fetch") {
    return cleanToolTargetText(display.title ?? display.url) ?? fallbackToolActionText(node);
  }
  if (display?.kind === "http_response") {
    const status = display.statusCode === undefined ? undefined : `HTTP ${display.statusCode}`;
    return previewLineTarget(display.bodyPreview) ?? cleanToolTargetText(status) ?? fallbackToolActionText(node);
  }
  if (display?.kind === "file_change_summary" || display?.kind === "file_diff_preview") {
    return fileChangeFallbackTarget(display) ??
      fallbackToolActionText(node);
  }
  if (display?.kind === "file_change_group") {
    return `${display.files.length} 个文件`;
  }
  if (display?.kind === "generic_tool_summary") {
    return genericActionTargetText(display.action) ?? fallbackToolActionText(node);
  }
  return fallbackToolActionText(node);
}

function genericActionTargetText(value: string | undefined): string | undefined {
  const cleaned = cleanToolTargetText(value);
  if (cleaned === undefined || isLowValueToolFallback(cleaned)) {
    return undefined;
  }
  return cleaned;
}

function previewLineTarget(value: string | undefined): string | undefined {
  const firstLine = value
    ?.split(/\r?\n/)
    .map((line) => cleanToolTargetText(line))
    .find((line): line is string => line !== undefined && line.length > 0);
  return firstLine;
}

function fileChangeFallbackTarget(display: FileDisplay): string | undefined {
  const operation = fileDisplayOperation(display);
  if (operation === "create") return "新增文件";
  if (operation === "delete") return "删除文件";
  if (operation === "append") return "追加内容";
  if (operation === "write") return "写入内容";
  if (operation === "edit" || display.preview !== undefined) return "内容变更";
  return undefined;
}

function fallbackToolActionText(node: ProjectableTranscriptNode): string | undefined {
  return cleanFallbackToolTitle(node.title) ?? fallbackToolNameText(node);
}

function cleanFallbackToolTitle(value: string | undefined): string | undefined {
  const cleaned = cleanToolTargetText(value)
    ?.replace(/^准备\s*/u, "")
    .replace(/(?:已)?完成$/u, "")
    .replace(/未完成$/u, "")
    .trim();
  if (cleaned === undefined || cleaned.length === 0 || isLowValueToolFallback(cleaned)) {
    return undefined;
  }
  return cleaned;
}

function fallbackToolNameText(node: ProjectableTranscriptNode): string | undefined {
  const toolName = normalizedToolName(node.toolName);
  if (toolName.length === 0) {
    return undefined;
  }
  const verb = toolVerb(node);
  if (verb === "读取") return toolName.includes("file") ? "读取文件" : "读取资料";
  if (verb === "查看") return "浏览目录";
  if (verb === "搜索") return "搜索";
  if (verb === "命令") return "运行命令";
  if (verb === "网页") return "读取网页";
  if (verb === "创建") return "创建文件";
  if (verb === "删除") return "删除文件";
  if (verb === "写入") return "写入文件";
  if (verb === "编辑") return "编辑文件";
  if (verb === "生成") return "生成内容";
  if (verb === "委派") return "协作任务";
  return cleanToolTargetText(toolName.replace(/[_-]+/g, " "));
}

function isLowValueToolFallback(value: string): boolean {
  const normalized = value.replace(/[。.!！?？；;:：、，,\s_-]/g, "").trim().toLowerCase();
  return normalized.length === 0 ||
    normalized === "tool" ||
    normalized === "工具" ||
    normalized === "使用工具" ||
    normalized === "工具结果" ||
    normalized === "工具调用" ||
    normalized === "动作";
}

function activityItemKey(node: ProjectableTranscriptNode): string {
  const ref = node.refs.find((item) =>
    item.kind === "tool_call" ||
    item.kind === "model_call" ||
    item.kind === "confirmation"
  );
  const owner = ref === undefined ? node.nodeId : `${ref.kind}:${ref.id}`;
  return `${node.runId}:${node.kind}:${owner}:${stableActivityEventKey(node)}`;
}

function stableActivityEventKey(node: ProjectableTranscriptNode): string {
  if (node.kind === "thinking" && node.eventType.startsWith("model.reasoning.")) {
    return "model.reasoning";
  }
  if (isModelSideOutputNode(node)) {
    return "model.side";
  }
  return node.eventType;
}

function activityToneForNode(node: ProjectableTranscriptNode): ActivityItem["tone"] {
  if (node.kind === "thinking") return "thinking";
  if (isModelRequestNode(node)) return "thinking";
  if (isModelSideOutputNode(node)) return "narration";
  if (node.kind === "tool") return "tool";
  if (node.kind === "confirmation") return "confirmation";
  if (node.kind === "user_decision") return "decision";
  return "system";
}

function readableActivityText(value: string): string {
  return value
    .replace(/`([^`]+)`/g, " $1 ")
    .replace(/([A-Za-z0-9])--(?=[A-Za-z])/g, "$1 --")
    .replace(/([A-Za-z])(?=\d)/g, "$1 ")
    .replace(/(\d(?:-\d+)?)(?=[A-Za-z])/g, "$1 ")
    .replace(/([A-Za-z]+'(?:ve|re|ll|d|m|t))(?=[A-Za-z])/gi, "$1 ")
    .replace(/([A-Za-z]+'s)(?=[A-Za-z])/g, "$1 ")
    .replace(/([A-Za-z0-9][.!?])(?=[A-Z])/g, "$1 ")
    .replace(/([A-Za-z0-9]),(?=[A-Za-z])/g, "$1, ")
    .replace(/([A-Za-z0-9]);(?=[A-Za-z])/g, "$1; ")
    .replace(/^[,;:，；：]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readableModelActivityText(value: string): string {
  return readableExpandedModelText(value).replace(/\s+/g, " ").trim();
}

function readableExpandedModelText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || isMarkdownDivider(trimmed)) {
        return "";
      }
      return stripMarkdownLinePrefix(trimmed);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readableToolTarget(value: string | undefined): Pick<ActivityLineCopy, "detail" | "expandedDetail"> | undefined {
  const text = readableActivityText(value ?? "");
  if (text.length === 0) return undefined;
  return { detail: text };
}

function readResultTarget(
  display: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "read_result" }>,
  summary: string | undefined,
): string | undefined {
  const target = cleanToolTargetText(display.title ?? display.uri ?? display.url ?? summary);
  if (target === undefined) {
    return undefined;
  }
  return compactReadTarget(target);
}

function compactReadTarget(value: string): string {
  const firstLine = value.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? value.trim();
  return firstLine
    .replace(/\s*[·•]\s*\d+(?:\.\d+)?\s*(?:bytes?|b|kb|mb)\b.*$/iu, "")
    .replace(/\s*[·•]\s*lines?\s+\d+(?:-\d+)?\s+of\s+\d+.*$/iu, "")
    .replace(/\s*[·•]\s*truncated\b.*$/iu, "")
    .replace(/\s+\d+(?:\.\d+)?\s*(?:bytes?|b|kb|mb)\b.*$/iu, "")
    .replace(/\s+lines?\s+\d+(?:-\d+)?\s+of\s+\d+.*$/iu, "")
    .replace(/\s+truncated\b.*$/iu, "")
    .trim();
}

function cleanToolTargetText(value: string | undefined): string | undefined {
  const text = cleanConfirmationSummary(value ?? "")
    .split(/\r?\n/)
    .map((line) => cleanOrdinaryToolText(line) ?? "")
    .join("\n")
    .replace(/^generic_tool_summary[:：]?\s*/i, "")
    .replace(/^(?:目标|搜索|命令|路径|文件|查询)[:：]\s*/u, "")
    .replace(/^\.(\s*·\s*)/u, "当前目录$1")
    .replace(/^\.$/u, "当前目录")
    .trim();
  return text.length === 0 ? undefined : text;
}

function searchResultLine(
  title: string | undefined,
  source: string | undefined,
  url: string | undefined,
): string {
  const headline = [title, source ?? compactHostLabel(url)]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join(" · ");
  return headline;
}

function compactHostLabel(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  try {
    return new URL(value).host.replace(/^www\./u, "") || value;
  } catch {
    return value;
  }
}

function narrationCandidate(value: string): string | undefined {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const collected: string[] = [];
  for (const line of lines) {
    if (isMarkdownDivider(line)) {
      continue;
    }
    const cleaned = stripMarkdownLinePrefix(line);
    if (cleaned.length === 0) continue;
    collected.push(cleaned);
    if (sentenceCount(collected.join(" ")) >= 2) break;
  }
  const joined = collected.join(" ");
  const text = stripMarkdownStructure(joined);
  return text.length === 0 ? undefined : text;
}

function stripMarkdownStructure(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      return isMarkdownDivider(trimmed) ? "" : stripMarkdownLinePrefix(trimmed);
    })
    .filter((line) => line.length > 0)
    .join(" ");
}

function stripMarkdownLinePrefix(value: string): string {
  return stripMarkdownEmphasis(value)
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+[.)、]\s+/, "")
    .replace(/^(?:\d\uFE0F?\u20E3|[①-⑳])\s*/u, "")
    .replace(/^[🔍📁📄📝✏️⚡🧠✅🖥️]\s*/u, "")
    .replace(/^>\s*/, "")
    .trim();
}

function stripMarkdownEmphasis(value: string): string {
  return value
    .replace(/^\*{1,2}\s*/, "")
    .replace(/\s*\*{1,2}$/, "")
    .trim();
}

function isMarkdownDivider(value: string): boolean {
  return /^-{3,}$/.test(value);
}

function takeNaturalSentences(value: string, maxSentences: number): string {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    if (!isSentenceBoundary(value, index, char)) {
      continue;
    }
    const sentence = value.slice(start, index + 1).trim();
    if (sentence.length > 0) {
      sentences.push(sentence);
    }
    start = index + 1;
    if (sentences.length >= maxSentences) {
      return sentences.join(" ").trim();
    }
  }
  const rest = value.slice(start).trim();
  if (rest.length > 0) {
    sentences.push(rest);
  }
  return sentences.length === 0 ? value : sentences.slice(0, maxSentences).join(" ").trim();
}

function sentenceCount(value: string): number {
  return value.split(/[。！？!?\.]+/).filter((part) => part.trim().length > 0).length;
}

function isSentenceBoundary(value: string, index: number, char: string): boolean {
  if (/[。！？!?]/u.test(char)) {
    return true;
  }
  if (char !== ".") {
    return false;
  }
  const next = value[index + 1] ?? "";
  return next.length === 0 || /\s/u.test(next);
}

function compact(value: string | undefined, maxLength: number): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}
