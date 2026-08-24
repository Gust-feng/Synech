import { cleanConfirmationSummary, isGenericApprovalDecisionText } from "../../../text-projection/confirmation-copy.js";
import {
  isModelSideOutputNode,
  type ProjectableTranscriptNode,
} from "./panel-transcript-node-projection.js";
import {
  fileActivityExpandedSections,
  fileActivityLead,
  fileActivityLineDelta,
  fileActivityTargetCopy,
  fileActivityVerb,
} from "./activity-copy-file.js";
import {
  readableActivityText,
  toolActivityExpandedSections,
  toolActivityLead,
  toolActivityTargetCopy,
  toolActivityVerb,
} from "./activity-copy-tool.js";

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
    const target = fileActivityTargetCopy(node) ?? toolActivityTargetCopy(node);
    const statusText = target === undefined ? toolStatusText(node) : undefined;
    if (target === undefined && statusText === undefined) {
      return undefined;
    }
    const copy = {
      label: fileActivityVerb(node) ?? toolActivityVerb(node),
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
      lineDelta: fileActivityLineDelta(node, copy),
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
    lineDelta: fileActivityLineDelta(node, copy),
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
  return fileActivityLead(node, copy) ?? toolActivityLead(node, copy);
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
  const sections: ActivityExpandedSection[] = [
    ...fileActivityExpandedSections(node, copy),
    ...toolActivityExpandedSections(node, copy),
  ];
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

function toolStatusText(node: ProjectableTranscriptNode): string | undefined {
  if (node.phase === "failed") return "动作失败";
  return undefined;
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
