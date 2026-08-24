import type { ToolDisplayProjection } from "../panel-api/tool-display.js";
import type { ToolCallRequest, ToolFactValue } from "../../domain/tools/index.js";
import { toolDisplayName } from "../../domain/tools/index.js";
import { commandProgramFromToolResult, commandTextFromToolResult } from "./command-text.js";
import {
  normalizeToolDisplayForOperation,
  projectToolDisplayResultFacts,
} from "./tool-display-normalization.js";
import {
  asRecord,
  isString,
  numberOrUndefined,
  readErrorMessageFromOutput,
  searchMessageFromOutput,
  stringArray,
  stringOrUndefined,
  textOrUndefined,
} from "./tool-result-facts.js";
const SEARCH_DISPLAY_RESULTS_LIMIT = 20;

export function projectToolDisplay(request: ToolCallRequest, output: ToolFactValue | undefined): ToolDisplayProjection {
  return {
    ...projectToolDisplayCore(request, output),
    ...projectToolDisplayResultFacts(output),
  };
}

function projectToolDisplayCore(request: ToolCallRequest, output: ToolFactValue | undefined): ToolDisplayProjection {
  const record = asRecord(output);
  const input = asRecord(request.input);
  if (request.toolName === "ResearchSearch" || request.toolName === "WebSearch") {
    const results = (Array.isArray(record.results) ? record.results : [])
      .slice(0, SEARCH_DISPLAY_RESULTS_LIMIT)
      .map(projectSearchDisplayItem)
      .filter((item): item is NonNullable<ReturnType<typeof projectSearchDisplayItem>> => item !== undefined);
    return {
      kind: "search_results",
      query: stringOrUndefined(record.query) ?? stringOrUndefined(input.query),
      message: stringOrUndefined(searchMessageFromOutput(record)),
      results,
    };
  }
  if (request.toolName === "ResearchRead" && Array.isArray(record.items)) {
    return {
      kind: "generic_tool_summary",
      action: toolDisplayName(request.toolName),
      summary: `${record.items.length} 个来源`,
      items: record.items.slice(0, 8).map(batchReadDisplayItem).filter(isString),
    };
  }
  if (request.toolName === "ResearchRead") {
    const error = readErrorMessageFromOutput(record);
    const uri = stringOrUndefined(record.uri) ?? stringOrUndefined(input.uri) ?? stringOrUndefined(input.ref);
    const url = httpUrl(uri);
    return {
      kind: "read_result",
      title: stringOrUndefined(record.title) ?? stringOrUndefined(input.title),
      url,
      uri,
      contentPreview: url === undefined ? stringOrUndefined(record.contentPreview) : undefined,
      error,
    };
  }
  const knowledgeDisplay = projectKnowledgeDisplay(request.toolName, input, record);
  if (knowledgeDisplay !== undefined) {
    return knowledgeDisplay;
  }
  const spaceDisplay = projectSpaceDisplay(request.toolName, input, record);
  if (spaceDisplay !== undefined) {
    return spaceDisplay;
  }
  if (request.toolName === "NoteWrite") {
    const scope = record.scope ?? input.scope;
    return {
      kind: "note_operation",
      operation: "write",
      status: stringOrUndefined(record.status),
      scope: scope === "workspace" || scope === "global" ? scope : undefined,
      characters: numberOrUndefined(record.characters),
    };
  }
  if (isContentReadTool(request.toolName)) {
    const uri = stringOrUndefined(record.uri) ?? stringOrUndefined(input.uri) ?? stringOrUndefined(input.ref);
    const url = stringOrUndefined(record.url) ?? stringOrUndefined(input.url) ?? httpUrl(uri);
    return {
      kind: "read_result",
      title: stringOrUndefined(record.title) ?? stringOrUndefined(record.path) ??
        stringOrUndefined(input.title) ?? stringOrUndefined(input.path),
      url,
      uri,
      contentPreview: url === undefined
        ? stringOrUndefined(record.content) ?? stringOrUndefined(record.text)
        : undefined,
    };
  }
  if (request.toolName === "WebFetch") {
    return {
      kind: "web_fetch",
      title: stringOrUndefined(record.title) ?? stringOrUndefined(input.title),
      url: stringOrUndefined(record.url) ?? stringOrUndefined(input.url),
    };
  }
  if (request.toolName === "HttpRequest") {
    return {
      kind: "http_response",
      method: stringOrUndefined(record.method) ?? stringOrUndefined(input.method),
      url: stringOrUndefined(record.url) ?? stringOrUndefined(input.url),
      statusCode: numberOrUndefined(record.statusCode),
      statusText: stringOrUndefined(record.statusText),
      bodyPreview: stringOrUndefined(record.body),
    };
  }
  if (isAgentTaskTool(request.toolName)) {
    return {
      kind: "agent_task",
      agentName: stringOrUndefined(input.sub_agent_name) ?? stringOrUndefined(input.role),
      task: stringOrUndefined(input.task),
      result: stringOrUndefined(output),
    };
  }
  if (request.toolName === "Shell" || request.toolName === "ProcessStop") {
    const stdout = textOrUndefined(record.stdout);
    const stderr = textOrUndefined(record.stderr);
    const commandLine = commandTextFromToolResult(record, request.input);
    return {
      kind: "command_summary",
      command: commandProgramFromToolResult(record, request.input),
      args: stringArray(record.args).length > 0 ? stringArray(record.args) : stringArray(asRecord(request.input).args),
      commandLine,
      exitCode: numberOrUndefined(record.exitCode),
      timedOut: record.timedOut === true,
      stdoutPreview: stdout,
      stderrPreview: stderr,
    };
  }
  return normalizeToolDisplayForOperation({
    toolName: request.toolName,
    input: request.input,
    output,
  });
}

function httpUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function isContentReadTool(toolName: string): boolean {
  return toolName === "Read" ||
    toolName === "AttachmentRead" ||
    toolName === "AttachmentReadPdf" ||
    toolName === "SkillRead";
}

function isAgentTaskTool(toolName: string): boolean {
  return toolName === "Agent" || toolName === "AgentSpawn";
}

function batchReadDisplayItem(value: unknown): string | undefined {
  const item = asRecord(value);
  const ref = stringOrUndefined(item.ref);
  const title = stringOrUndefined(item.title);
  const error = stringOrUndefined(item.error);
  const headline = title ?? ref;
  if (headline === undefined) {
    return error;
  }
  return error === undefined ? headline : `${headline} · ${error}`;
}

export function projectSearchDisplayItem(value: unknown): Extract<ToolDisplayProjection, { readonly kind: "search_results" }>["results"][number] | undefined {
  const item = asRecord(value);
  const title = stringOrUndefined(item.title);
  if (title === undefined) {
    return undefined;
  }
  return {
    title,
    url: stringOrUndefined(item.url) ?? stringOrUndefined(item.uri),
    source: stringOrUndefined(item.source),
  };
}

function projectKnowledgeDisplay(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  output: Readonly<Record<string, unknown>>,
): Extract<ToolDisplayProjection, { readonly kind: "knowledge_operation" }> | undefined {
  const operation = knowledgeOperation(toolName);
  if (operation === undefined) return undefined;
  const note = asRecord(output.note);
  const page = asRecord(output.page);
  const results = Array.isArray(output.results) ? output.results : [];
  const items = results.map((value) => {
    const result = asRecord(value);
    const resultNote = asRecord(result.note);
    const noteId = stringOrUndefined(resultNote.id);
    if (noteId === undefined) return undefined;
    return {
      noteId,
      title: stringOrUndefined(resultNote.title),
      spaceId: stringOrUndefined(resultNote.spaceId),
      revision: numberOrUndefined(resultNote.revision),
      snippet: stringOrUndefined(result.snippet),
    };
  }).filter((item): item is NonNullable<typeof item> => item !== undefined);
  return {
    kind: "knowledge_operation",
    operation,
    status: stringOrUndefined(output.status),
    query: stringOrUndefined(output.query) ?? stringOrUndefined(input.query),
    spaceId: stringOrUndefined(note.spaceId) ?? stringOrUndefined(input.spaceId),
    noteId: stringOrUndefined(note.id) ?? stringOrUndefined(output.noteId) ?? stringOrUndefined(input.noteId) ?? stringOrUndefined(page.refId),
    title: stringOrUndefined(note.title) ?? stringOrUndefined(input.title),
    revision: numberOrUndefined(note.revision) ?? numberOrUndefined(output.revision),
    count: numberOrUndefined(output.count) ?? (Array.isArray(output.results) ? output.results.length : undefined),
    items: items.length === 0 ? undefined : items,
  };
}

function knowledgeOperation(toolName: string): Extract<ToolDisplayProjection, { readonly kind: "knowledge_operation" }>["operation"] | undefined {
  if (toolName === "KnowledgeSearch") return "search";
  if (toolName === "KnowledgeRead") return "read";
  if (toolName === "KnowledgeCreateNote") return "create_note";
  if (toolName === "KnowledgeUpdateNote") return "update_note";
  if (toolName === "KnowledgeCollect") return "collect";
  return undefined;
}

function projectSpaceDisplay(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  output: Readonly<Record<string, unknown>>,
): Extract<ToolDisplayProjection, { readonly kind: "space_operation" }> | undefined {
  const operation = spaceOperation(toolName);
  if (operation === undefined) return undefined;
  const space = asRecord(output.space);
  const tree = asRecord(output.tree);
  const treeSpace = asRecord(tree.space);
  const item = asRecord(output.item);
  const target = asRecord(output.target);
  const spaces = Array.isArray(output.spaces) ? output.spaces : [];
  const items = spaces.map((value) => {
    const candidate = asRecord(value);
    const spaceId = stringOrUndefined(candidate.id);
    if (spaceId === undefined) return undefined;
    return {
      spaceId,
      title: stringOrUndefined(candidate.title),
      folderCount: numberOrUndefined(candidate.folderCount),
      referenceItemCount: numberOrUndefined(candidate.referenceItemCount),
    };
  }).filter((value): value is NonNullable<typeof value> => value !== undefined);
  return {
    kind: "space_operation",
    operation,
    status: stringOrUndefined(output.status),
    spaceId: stringOrUndefined(space.id) ?? stringOrUndefined(treeSpace.id) ?? stringOrUndefined(item.spaceId) ?? stringOrUndefined(input.spaceId),
    title: stringOrUndefined(space.title) ?? stringOrUndefined(treeSpace.title) ?? stringOrUndefined(item.title) ?? stringOrUndefined(output.title) ?? stringOrUndefined(input.title),
    targetId: stringOrUndefined(target.id) ?? stringOrUndefined(output.itemId) ?? stringOrUndefined(input.targetId) ?? stringOrUndefined(input.itemId),
    destinationSpaceId: stringOrUndefined(output.destinationSpaceId) ?? stringOrUndefined(input.destinationSpaceId),
    count: items.length > 0 ? items.length : Array.isArray(tree.entries) ? tree.entries.length : undefined,
    items: items.length === 0 ? undefined : items,
  };
}

function spaceOperation(toolName: string): Extract<ToolDisplayProjection, { readonly kind: "space_operation" }>["operation"] | undefined {
  if (toolName === "SpaceList") return "list";
  if (toolName === "SpaceCreate") return "create";
  if (toolName === "SpaceMove") return "move";
  if (toolName === "SpaceAddReference") return "add_reference";
  if (toolName === "SpaceMountLocalPath") return "mount";
  if (toolName === "SpaceCreateManagedFolder") return "create_managed_folder";
  if (toolName === "SpaceCreateEntry") return "create_entry";
  if (toolName === "SpaceRenameEntry") return "rename_entry";
  if (toolName === "SpaceDeleteEntry") return "delete_entry";
  if (toolName === "SpaceUpdateCaption") return "update_caption";
  if (toolName === "SpaceRemoveReference") return "remove_reference";
  if (toolName === "SpaceRename") return "rename";
  return undefined;
}
