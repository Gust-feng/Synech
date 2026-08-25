import type { ToolFactValue } from "../../../../domain/tools/index.js";
import { cleanConfirmationSummary } from "../../../text-projection/confirmation-copy.js";
import { cleanOrdinaryToolText } from "../tool-projection/ordinary-tool-copy.js";
import {
  isFileReadNode,
  type ProjectableTranscriptNode,
} from "./panel-transcript-node-projection.js";
import { commandText, genericItemLabel } from "./panel-transcript-tool-format.js";
import type {
  ActivityExpandedItem,
  ActivityExpandedSection,
  ActivityLead,
  ActivityLineCopy,
} from "./panel-transcript-activity-copy.js";

const EXPANDED_SEARCH_RESULTS_LIMIT = 20;

type GenericToolSummaryDisplay = Extract<
  NonNullable<ProjectableTranscriptNode["display"]>,
  { readonly kind: "generic_tool_summary" }
>;

export function toolActivityVerb(node: ProjectableTranscriptNode): string {
  const display = node.display;
  if (display?.kind === "raw_tool_result") return "工具";
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
  if (display?.kind === "agent_task") return "委派";
  if (display?.kind === "command_summary") return "命令";
  if (display?.kind === "search_results") return "搜索";
  if (display?.kind === "file_search_results") return "搜索";
  if (display?.kind === "directory_listing") return "查看";
  if (display?.kind === "http_response") return "请求";
  if (display?.kind === "generic_tool_summary") return genericCategoryLabel(display.category);
  if (display?.kind === "read_result") return "读取";
  if (display?.kind === "web_fetch") return "网页";
  return "工具";
}

function genericCategoryLabel(category: GenericToolSummaryDisplay["category"]): string {
  if (category === "read") return "读取";
  if (category === "search") return "搜索";
  if (category === "web") return "网页";
  if (category === "command") return "命令";
  if (category === "edit") return "编辑";
  return "工具";
}

export function toolActivityTargetCopy(
  node: ProjectableTranscriptNode,
): Pick<ActivityLineCopy, "detail" | "expandedDetail"> | undefined {
  const display = node.display;
  if (display?.kind === "command_summary") return { detail: "终端" };
  if (display?.kind === "search_results") {
    const query = cleanToolTargetText(display.query);
    if (query !== undefined) return readableToolTarget(query);
    const message = cleanToolTargetText(display.message);
    if ((node.phase === "failed" || node.phase === "blocked") && message !== undefined) {
      return readableToolTarget(message);
    }
    const firstResult = display.results
      .map((result) => cleanToolTargetText(result.title) ?? cleanToolTargetText(result.source) ?? cleanToolTargetText(result.url))
      .find((result): result is string => result !== undefined);
    if (firstResult !== undefined) return readableToolTarget(firstResult);
    return { detail: display.results.length > 0 ? "网页资料" : "未找到相关内容" };
  }
  if (display?.kind === "web_fetch") {
    return readableToolTarget(cleanToolTargetText(display.title ?? display.url ?? node.summary)) ??
      toolFallbackTargetCopy(node);
  }
  if (display?.kind === "http_response") {
    const target = [display.method, display.url]
      .filter((value): value is string => value !== undefined && value.trim().length > 0)
      .join(" ");
    return readableToolTarget(cleanToolTargetText(target || node.summary)) ?? toolFallbackTargetCopy(node);
  }
  if (display?.kind === "agent_task") {
    return { detail: cleanToolTargetText(display.agentName) ?? cleanToolTargetText(display.task) ?? "协作任务" };
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
  if (display?.kind === "generic_tool_summary") {
    const items = (display.items ?? [])
      .map((item) => cleanToolTargetText(genericItemLabel(item)) ?? "")
      .filter((value) => value.length > 0);
    const summary = cleanToolTargetText(display.summary ?? node.summary);
    if (summary !== undefined && items.length > 1) {
      return { detail: readableActivityText(summary), expandedDetail: items.join("\n") };
    }
    if (items.length === 1) return readableToolTarget(items[0]);
    if (items.length > 1) {
      return {
        detail: isFileReadNode(node) ? `${items.length} 个文件` : `${items.length} 项`,
        expandedDetail: items.join("\n"),
      };
    }
    return readableToolTarget(summary ?? genericActionTargetText(display.action)) ?? toolFallbackTargetCopy(node);
  }
  if (display?.kind === "raw_tool_result") return { detail: display.label };
  return display === undefined
    ? readableToolTarget(cleanToolTargetText(node.summary)) ?? toolFallbackTargetCopy(node)
    : undefined;
}

export function toolActivityLead(
  node: ProjectableTranscriptNode,
  copy: ActivityLineCopy,
): ActivityLead | undefined {
  if (node.kind !== "tool") return undefined;
  const action = copy.label ?? toolActivityVerb(node);
  const display = node.display;
  if (display?.kind === "command_summary") {
    const issue = node.phase === "failed" || node.phase === "blocked" ||
      (display.exitCode !== undefined && display.exitCode !== 0) || display.timedOut === true;
    return makeActivityLead({
      action: "运行",
      subject: "终端",
      context: issue ? display.timedOut === true ? "执行超时" : "运行失败" : undefined,
    });
  }
  if (display?.kind === "search_results") {
    return makeActivityLead({
      action,
      subject: cleanToolTargetText(display.query) ?? display.results[0]?.title ?? copy.detail,
      context: node.phase === "failed" || node.phase === "blocked"
        ? cleanToolTargetText(display.message)
        : undefined,
    });
  }
  if (display?.kind === "web_fetch") {
    return makeActivityLead({ action, subject: cleanToolTargetText(display.title ?? display.url) ?? copy.detail });
  }
  if (display?.kind === "http_response") {
    const request = [display.method, display.url]
      .filter((value): value is string => value !== undefined && value.trim().length > 0)
      .join(" ");
    const status = display.statusCode === undefined || display.statusCode < 400
      ? undefined
      : [`HTTP ${display.statusCode}`, display.statusText].filter(isString).join(" ");
    return makeActivityLead({ action, subject: request || copy.detail, context: status, monospace: true });
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
  if (display?.kind === "generic_tool_summary") {
    return makeActivityLead({
      action,
      subject: cleanToolTargetText(display.summary) ?? display.items?.[0] ?? copy.detail,
    });
  }
  if (display?.kind === "raw_tool_result") {
    return makeActivityLead({ action: "工具", subject: display.label });
  }
  return display === undefined ? makeActivityLead({ action, subject: copy.detail }) : undefined;
}

export function toolActivityExpandedSections(
  node: ProjectableTranscriptNode,
  copy: ActivityLineCopy,
): readonly ActivityExpandedSection[] {
  const display = node.display;
  if (display?.kind === "command_summary") {
    const sections: ActivityExpandedSection[] = [];
    const command = commandText(display);
    if (command !== undefined) sections.push({ title: "命令", content: `$ ${command}`, format: "console" });
    const output = commandOutputForActivity(display);
    if (output !== undefined) {
      sections.push({
        title: "输出",
        content: output,
        format: "console",
        tone: stdoutMissingWithError(display) ? "danger" : undefined,
      });
    }
    return sections;
  }
  if (display?.kind === "search_results") {
    const visibleResults = display.results.slice(0, EXPANDED_SEARCH_RESULTS_LIMIT);
    const results = visibleResults.map((result) => searchResultLine(result.title, result.source, result.url));
    if (results.length > 0) {
      return [{
        title: "来源",
        content: results.join("\n"),
        format: "source_list",
        items: visibleResults.map(searchResultItem),
      }];
    }
    return display.message === undefined ? [] : [{ title: "提示", content: display.message }];
  }
  if (display?.kind === "web_fetch") {
    const source = sourceSection("来源", { title: display.title ?? display.url, url: display.url });
    return source === undefined ? [] : [source];
  }
  if (display?.kind === "http_response") {
    return display.bodyPreview === undefined
      ? []
      : [{ title: "内容预览", content: display.bodyPreview, format: "code" }];
  }
  if (display?.kind === "agent_task") {
    return display.result === undefined ? [] : [{ title: "结果", content: display.result }];
  }
  if (display?.kind === "generic_tool_summary") return genericToolSections(display, copy);
  if (display?.kind === "raw_tool_result" && display.value !== undefined) {
    return [{ title: "原始结果", content: rawToolResultText(display.value), format: "code" }];
  }
  return [];
}

export function toolFallbackTargetCopy(
  node: ProjectableTranscriptNode,
): Pick<ActivityLineCopy, "detail" | "expandedDetail"> | undefined {
  return readableToolTarget(fallbackToolTargetText(node));
}

export function cleanToolTargetText(value: string | undefined): string | undefined {
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

export function readableActivityText(value: string): string {
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

export function readableToolTarget(
  value: string | undefined,
): Pick<ActivityLineCopy, "detail" | "expandedDetail"> | undefined {
  const text = readableActivityText(value ?? "");
  return text.length === 0 ? undefined : { detail: text };
}

export function sourceSection(
  title: string,
  input: { readonly title?: string; readonly url?: string },
): ActivityExpandedSection | undefined {
  const content = cleanToolTargetText(input.title) ?? cleanToolTargetText(input.url);
  if (content === undefined) return undefined;
  const href = httpHref(input.url);
  return { title, content, format: href === undefined ? "plain" : "source", href };
}

export function urlLikeValue(value: string | undefined): string | undefined {
  return httpHref(value);
}

export function uniqueStrings(values: readonly string[]): readonly string[] {
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

function makeActivityLead(input: {
  readonly action: string;
  readonly subject: string;
  readonly context?: string;
  readonly monospace?: boolean;
}): ActivityLead {
  const action = compact(readableActivityText(input.action), 40);
  const readableSubject = input.monospace === true ? input.subject.trim() : readableActivityText(input.subject);
  const context = input.context === undefined ? undefined : readableActivityText(input.context);
  return {
    action: action.length === 0 ? "工具" : action,
    subject: readableSubject.length === 0 ? "工具活动" : readableSubject,
    ...(context === undefined || context.length === 0 ? {} : { context }),
    ...(input.monospace === true ? { monospace: true } : {}),
  };
}

function commandOutputForActivity(
  display: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "command_summary" }>,
): string | undefined {
  const parts = [display.stdoutPreview, display.stderrPreview]
    .filter((value): value is string => value !== undefined && value.length > 0);
  return parts.length === 0 ? undefined : parts.join("\n");
}

function stdoutMissingWithError(
  display: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "command_summary" }>,
): boolean {
  return display.stdoutPreview === undefined && display.stderrPreview !== undefined;
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

function searchResultLine(title: string | undefined, source: string | undefined, url: string | undefined): string {
  return [title, source ?? compactHostLabel(url)]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join(" · ");
}

function compactHostLabel(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  try {
    return new URL(value).host.replace(/^www\./u, "") || value;
  } catch {
    return value;
  }
}

function genericToolSections(
  display: GenericToolSummaryDisplay,
  copy: ActivityLineCopy,
): readonly ActivityExpandedSection[] {
  const sections: ActivityExpandedSection[] = [];
  const summary = cleanGenericSummaryText(display.summary);
  if (summary !== undefined && !genericTextAlreadyRepresented(summary, sections, copy)) {
    sections.push({ title: "内容", content: summary });
  }
  const items = uniqueStrings(
    (display.items ?? [])
      .map((item) => cleanGenericSummaryText(genericItemLabel(item)) ?? "")
      .filter((value) => value.length > 0)
      .filter((value) => !genericTextAlreadyRepresented(value, sections, copy)),
  );
  if (items.length > 0) sections.push({ title: "条目", content: items.join("\n"), format: "list" });
  return sections;
}

function rawToolResultText(value: ToolFactValue): string {
  return typeof value === "string" ? value : JSON.stringify(value, undefined, 2) ?? String(value);
}

function cleanGenericSummaryText(value: string | undefined): string | undefined {
  return cleanToolTargetText(value)?.replace(/\n{3,}/g, "\n\n").trim();
}

function genericTextAlreadyRepresented(
  value: string,
  sections: readonly ActivityExpandedSection[],
  copy: ActivityLineCopy,
): boolean {
  const normalized = normalizeSectionContent(value);
  if (normalized.length === 0 || normalizeSectionContent(copy.detail) === normalized) return true;
  return sections.some((section) => {
    const content = normalizeSectionContent(section.content);
    return content === normalized || content.includes(normalized) || normalized.includes(content);
  });
}

function normalizeSectionContent(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[。.!！?？；;:：、，,\s]/g, "").trim().toLowerCase();
}

function fallbackToolTargetText(node: ProjectableTranscriptNode): string | undefined {
  const display = node.display;
  if (display?.kind === "command_summary") {
    return cleanToolTargetText(display.stderrPreview) ?? cleanToolTargetText(display.stdoutPreview) ?? fallbackToolActionText(node);
  }
  if (display?.kind === "search_results") {
    const firstResult = display.results
      .map((result) => cleanToolTargetText(result.title) ?? cleanToolTargetText(result.source) ?? cleanToolTargetText(result.url))
      .find((value): value is string => value !== undefined && value.length > 0);
    return firstResult ?? (display.results.length > 0 ? `${display.results.length} 条结果` : undefined) ?? fallbackToolActionText(node);
  }
  if (display?.kind === "web_fetch") return cleanToolTargetText(display.title ?? display.url) ?? fallbackToolActionText(node);
  if (display?.kind === "http_response") {
    const status = display.statusCode === undefined ? undefined : `HTTP ${display.statusCode}`;
    return previewLineTarget(display.bodyPreview) ?? cleanToolTargetText(status) ?? fallbackToolActionText(node);
  }
  if (display?.kind === "generic_tool_summary") return genericActionTargetText(display.action) ?? fallbackToolActionText(node);
  if (display?.kind === "raw_tool_result") return display.label;
  return fallbackToolActionText(node);
}

function genericActionTargetText(value: string | undefined): string | undefined {
  return cleanToolTargetText(value);
}

function previewLineTarget(value: string | undefined): string | undefined {
  return value
    ?.split(/\r?\n/)
    .map((line) => cleanToolTargetText(line))
    .find((line): line is string => line !== undefined && line.length > 0);
}

function fallbackToolActionText(node: ProjectableTranscriptNode): string | undefined {
  return cleanFallbackToolTitle(node.title);
}

function cleanFallbackToolTitle(value: string | undefined): string | undefined {
  const cleaned = cleanToolTargetText(value);
  return cleaned === undefined || cleaned.length === 0 ? undefined : cleaned;
}

function httpHref(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function compact(value: string | undefined, maxLength: number): string {
  const text = value?.trim() ?? "";
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function isString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
