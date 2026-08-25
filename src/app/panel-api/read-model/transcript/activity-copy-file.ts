import type { ProjectableTranscriptNode } from "./panel-transcript-node-projection.js";
import type {
  ActivityBadge,
  ActivityExpandedItem,
  ActivityExpandedSection,
  ActivityLead,
  ActivityLineCopy,
  ActivityLineDelta,
} from "./panel-transcript-activity-copy.js";
import {
  cleanToolTargetText,
  readableActivityText,
  readableToolTarget,
  sourceSection,
  toolFallbackTargetCopy,
  uniqueStrings,
  urlLikeValue,
} from "./activity-copy-tool.js";

const EXPANDED_DIRECTORY_ENTRIES_LIMIT = 80;
const EXPANDED_FILE_SEARCH_MATCHES_LIMIT = 80;

type FileDisplay = Extract<
  NonNullable<ProjectableTranscriptNode["display"]>,
  { readonly kind: "file_change_summary" | "file_diff_preview" }
>;
type FileDisplayOperation = NonNullable<FileDisplay["operation"]>;

export function fileActivityVerb(node: ProjectableTranscriptNode): string | undefined {
  const display = node.display;
  if (display?.kind === "file_search_results") return "搜索";
  if (display?.kind === "directory_listing") return "查看";
  if (display?.kind === "read_result") return "读取";
  const mutation = fileMutationVerbForTool(display);
  if (mutation !== undefined) return mutation;
  return undefined;
}

export function fileActivityTargetCopy(
  node: ProjectableTranscriptNode,
): Pick<ActivityLineCopy, "detail" | "expandedDetail"> | undefined {
  const display = node.display;
  if (display?.kind === "directory_listing") {
    return { detail: readableActivityText(directoryListingHeadline(display)) };
  }
  if (display?.kind === "file_search_results") {
    return { detail: readableActivityText(fileSearchHeadline(display)) };
  }
  if (display?.kind === "read_result") {
    return readableToolTarget(readResultTarget(display, node.summary)) ??
      readableToolTarget(
        cleanToolTargetText(display.error) ??
        previewLineTarget(display.contentPreview) ??
        cleanToolTargetText(display.title ?? display.url ?? display.uri),
      ) ??
      toolFallbackTargetCopy(node) ??
      { detail: "读取资料" };
  }
  if (display?.kind === "file_change_summary" || display?.kind === "file_diff_preview") {
    return readableToolTarget(cleanToolTargetText(display.path ?? node.summary)) ??
      readableToolTarget(fileChangeFallbackTarget(display)) ??
      { detail: fileActivityVerb(node) === "删除" ? "删除文件" : "内容变更" };
  }
  if (display?.kind === "file_change_group") return { detail: `${display.files.length} 个文件` };
  if (display === undefined && fileActivityVerb(node) !== undefined) {
    const summary = readableToolTarget(cleanToolTargetText(node.summary));
    if (summary !== undefined) return summary;
    const verb = fileActivityVerb(node);
    if (verb === "读取") return { detail: "读取资料" };
    if (verb === "查看") return { detail: "浏览目录" };
    if (verb === "创建") return { detail: "创建文件" };
    if (verb === "删除") return { detail: "删除文件" };
    if (verb === "写入") return { detail: "写入文件" };
    if (verb === "编辑") return { detail: "编辑文件" };
  }
  return undefined;
}

export function fileActivityLead(
  node: ProjectableTranscriptNode,
  copy: ActivityLineCopy,
): ActivityLead | undefined {
  const display = node.display;
  const action = copy.label ?? fileActivityVerb(node) ?? "动作";
  if (display?.kind === "directory_listing") {
    return makeFileLead({ action, subject: toolPathLabel(display.path) ?? copy.detail, monospace: true });
  }
  if (display?.kind === "file_search_results") {
    return makeFileLead({
      action,
      subject: cleanToolTargetText(display.query) ?? "项目内容",
      context: node.phase === "completed" && display.matches.length === 0 ? "未找到匹配" : undefined,
      monospace: true,
    });
  }
  if (display?.kind === "read_result") {
    const remote = display.url !== undefined || urlLikeValue(display.uri) !== undefined;
    return makeFileLead({
      action,
      subject: readResultTarget(display, node.summary) ?? copy.detail,
      context: display.error,
      monospace: !remote,
    });
  }
  if (display?.kind === "file_change_summary" || display?.kind === "file_diff_preview") {
    return makeFileLead({
      action,
      subject: cleanToolTargetText(display.path) ?? copy.detail,
      monospace: display.path !== undefined,
    });
  }
  if (display?.kind === "file_change_group") {
    return makeFileLead({ action, subject: `${display.files.length} 个文件` });
  }
  return undefined;
}

export function fileActivityExpandedSections(
  node: ProjectableTranscriptNode,
  copy: ActivityLineCopy,
): readonly ActivityExpandedSection[] {
  const display = node.display;
  if (display?.kind === "directory_listing") {
    const sections: ActivityExpandedSection[] = [];
    const visibleEntries = display.entries.slice(0, EXPANDED_DIRECTORY_ENTRIES_LIMIT);
    const entries = visibleEntries.map(directoryEntryTitle);
    if (entries.length > 0) {
      sections.push({
        sectionId: "entries",
        title: "条目",
        content: entries.join("\n"),
        format: "path_list",
        items: visibleEntries.map(directoryEntryItem),
      });
    }
    const unreadable = display.unreadableSamples
      ?.slice(0, 6)
      .map((item) => [item.path, item.errorCode]
        .filter((value): value is string => value !== undefined && value.length > 0)
        .join(" · "))
      .filter((value) => value.length > 0);
    if ((unreadable?.length ?? 0) > 0) {
      sections.push({ sectionId: "unreadable_entries", title: "异常目录", content: unreadable!.join("\n"), format: "list", tone: "warning" });
    }
    return sections;
  }
  if (display?.kind === "file_search_results") {
    const visibleMatches = display.matches.slice(0, EXPANDED_FILE_SEARCH_MATCHES_LIMIT);
    const matches = visibleMatches.map(fileSearchMatchLine);
    return matches.length === 0 ? [] : [{
      sectionId: "matches",
      title: "匹配位置",
      content: matches.join("\n"),
      format: "path_list",
      items: visibleMatches.map(fileSearchMatchItem),
    }];
  }
  if (display?.kind === "read_result") {
    const sections: ActivityExpandedSection[] = [];
    const source = sourceSection("来源", {
      title: display.title ?? display.url ?? display.uri,
      url: display.url ?? urlLikeValue(display.uri),
    });
    if (source?.format === "source") sections.push(source);
    if (display.contentPreview !== undefined && source?.format !== "source") {
      sections.push({ sectionId: "content", title: "内容", content: display.contentPreview, format: "code" });
    }
    if (display.error !== undefined) sections.push({ sectionId: "error", title: "错误", content: display.error, tone: "danger" });
    return sections;
  }
  if (display?.kind === "file_change_group") {
    const previews = display.files.flatMap((file) => {
      const preview = cleanFilePreviewContent(file.preview);
      return preview === undefined ? [] : [{
        sectionId: `file_preview:${file.path}`,
        title: file.path,
        content: preview,
        format: filePreviewLooksLikeDiff(preview) ? "diff" as const : "code" as const,
      }];
    });
    return previews.length > 0 ? previews : [{
      sectionId: "files",
      title: "文件",
      content: display.files.map((file) => file.path).join("\n"),
      format: "path_list",
      items: display.files.map((file) => ({ title: file.path, monospace: true })),
    }];
  }
  if (display?.kind === "file_change_summary" || display?.kind === "file_diff_preview") {
    const preview = filePreviewContentForActivity(display, node, copy);
    if (preview !== undefined) {
      return [{
        sectionId: "change_preview",
        title: filePreviewSectionTitle(display),
        content: preview,
        format: display.kind === "file_diff_preview" || filePreviewLooksLikeDiff(preview) ? "diff" : "code",
      }];
    }
    if (node.phase !== "completed") {
      const summary = fileChangeSummary(display);
      if (summary !== undefined) {
        return [{ sectionId: "change_summary", title: "变更", content: summary, tone: fileOperationTone(fileDisplayOperation(display)) }];
      }
    }
  }
  return [];
}

export function fileActivityLineDelta(
  node: ProjectableTranscriptNode,
  copy: ActivityLineCopy,
): ActivityLineDelta | undefined {
  const display = node.display;
  const previews = display?.kind === "file_change_group"
    ? display.files.map((file) => file.preview)
    : display?.kind === "file_change_summary" || display?.kind === "file_diff_preview"
      ? [filePreviewContentForActivity(display, node, copy)]
      : [];
  return mergeLineDeltas(previews.map(lineDeltaFromDiffPreview));
}

function fileMutationVerbForTool(
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
  return undefined;
}

function directoryEntryItem(
  entry: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "directory_listing" }>["entries"][number],
): ActivityExpandedItem {
  return { title: directoryEntryTitle(entry), monospace: true };
}

function directoryEntryTitle(
  entry: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "directory_listing" }>["entries"][number],
): string {
  return entry.kind === "directory" && !entry.path.endsWith("/") ? `${entry.path}/` : entry.path;
}

function directoryListingHeadline(
  display: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "directory_listing" }>,
): string {
  return toolPathLabel(display.path) ?? "目录内容";
}

function fileSearchHeadline(
  display: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "file_search_results" }>,
): string {
  return cleanToolTargetText(display.query) ?? toolPathLabel(display.path) ?? "项目内容";
}

function toolPathLabel(value: string | undefined): string | undefined {
  return value === "." ? "当前目录" : cleanToolTargetText(value);
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

function fileDisplayOperation(display: FileDisplay): FileDisplayOperation | undefined {
  if (display.operation !== undefined) return display.operation;
  return display.kind === "file_diff_preview" ? "edit" : undefined;
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
  if (display.kind === "file_diff_preview") return "差异预览";
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
  const cleaned = value
    ?.replace(/^变更预览\s*$/gmu, "")
    .replace(/^替换[:：]\s*\d+\s*处\s*$/gmu, "")
    .trim();
  return cleaned === undefined || cleaned.length === 0 ? undefined : cleaned;
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

function readResultTarget(
  display: Extract<NonNullable<ProjectableTranscriptNode["display"]>, { readonly kind: "read_result" }>,
  summary: string | undefined,
): string | undefined {
  const target = cleanToolTargetText(display.title ?? display.uri ?? display.url ?? summary);
  if (target === undefined) return undefined;
  const firstLine = target.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? target.trim();
  return firstLine
    .replace(/\s*[·•]\s*\d+(?:\.\d+)?\s*(?:bytes?|b|kb|mb)\b.*$/iu, "")
    .replace(/\s*[·•]\s*lines?\s+\d+(?:-\d+)?\s+of\s+\d+.*$/iu, "")
    .replace(/\s*[·•]\s*truncated\b.*$/iu, "")
    .replace(/\s+\d+(?:\.\d+)?\s*(?:bytes?|b|kb|mb)\b.*$/iu, "")
    .replace(/\s+lines?\s+\d+(?:-\d+)?\s+of\s+\d+.*$/iu, "")
    .replace(/\s+truncated\b.*$/iu, "")
    .trim();
}

function previewLineTarget(value: string | undefined): string | undefined {
  return value
    ?.split(/\r?\n/)
    .map((line) => cleanToolTargetText(line))
    .find((line): line is string => line !== undefined && line.length > 0);
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
  if (preview === undefined) return undefined;
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
    if (!insideHunk || (!hasHunks && (line.startsWith("+++ ") || line.startsWith("--- ")))) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return added === 0 && removed === 0 ? undefined : { added, removed };
}

function filePreviewLooksLikeDiff(value: string): boolean {
  return value.split("\n").some((line) => line.startsWith("+") || line.startsWith("-") || line.startsWith("@@"));
}

function makeFileLead(input: {
  readonly action: string;
  readonly subject: string;
  readonly context?: string;
  readonly monospace?: boolean;
}): ActivityLead {
  const action = compact(readableActivityText(input.action), 40);
  const subject = input.monospace === true ? input.subject.trim() : readableActivityText(input.subject);
  const context = input.context === undefined ? undefined : readableActivityText(input.context);
  return {
    action: action.length === 0 ? "工具" : action,
    subject: subject.length === 0 ? "工具活动" : subject,
    ...(context === undefined || context.length === 0 ? {} : { context }),
    ...(input.monospace === true ? { monospace: true } : {}),
  };
}

function compact(value: string | undefined, maxLength: number): string {
  const text = value?.trim() ?? "";
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
