import type { ToolExecutionContext, ToolExecutor } from "../../domain/tools/index.js";
import { asRecord, stringOrUndefined } from "../../kernel/values/index.js";
import {
  AGENT_NOTE_MAX_CHARS,
  AgentNotesError,
  type AgentNotesFeature,
  type AgentNotebook,
  type AgentNoteOwner,
  type AgentNoteScope,
  type AgentNoteVersion,
  type AgentNoteVersions,
} from "./contracts.js";

export type NoteToolOptions = {
  readonly notes: Pick<AgentNotesFeature, "commands" | "queries">;
  /**
   * 当前 run 冻结的 Space / Workspace owner；模型不能通过工具参数改写它。
   * Capability catalog 构建期没有具体 run，因此可缺失；此时 executor 只提供
   * 静态 definition，实际写入会明确拒绝。
   */
  readonly owner?: AgentNoteOwner;
  /** 与当前 run 系统提示词中冻结正文对应的版本；catalog-only 装配时不存在。 */
  readonly initialVersions?: AgentNoteVersions;
};

/**
 * NoteWrite：模型主动沉淀记忆的工具。
 *
 * 设计要点：
 * - 全量替换而不是追加：整理、合并、删旧对模型来说就是普通的编辑动作，
 *   不需要工程提供 merge 语义，也避免笔记只增不减地膨胀。
 * - 工具描述指导模型"先读当前笔记再写完整新版"；当前笔记在系统提示词中
 *   已全文注入，模型天然看得到最新内容。
 * - 低风险写入（只写 runtime 下的笔记文件，不触碰用户工作区），不需要确认。
 */
export function createNoteWriteTool(options: NoteToolOptions): ToolExecutor {
  const expectedVersions: {
    global: AgentNoteVersion;
    owner: { readonly scope: AgentNoteOwner; version: AgentNoteVersion };
  } | undefined = options.initialVersions === undefined
    ? undefined
    : {
        global: options.initialVersions.global,
        owner: { ...options.initialVersions.owner },
      };
  const pendingConflicts: Partial<Record<"global" | "owner", AgentNotebook>> = {};
  return {
    definition: {
      name: "NoteWrite",
      description:
        "Save your long-term notes so future sessions remember what you learned. " +
        "Write the COMPLETE revised note content (this replaces the whole note, so keep everything still worth keeping). " +
        "Use scope \"owner\" for the current Space or Workspace: structure, build/test commands, conventions, pitfalls you hit and how you solved them, decisions the user confirmed. " +
        "Use scope \"global\" for cross-project user preferences: language, reply style, recurring tooling choices. " +
        "Record insights and conclusions in your own words; do not transcribe conversation logs or tool output. " +
        "If the note changed since this run started, merge your intended revision with the current content returned by the conflict and retry. " +
        `Max ${AGENT_NOTE_MAX_CHARS} characters per note; if the write is rejected as too large, condense and retry.`,
      metadata: {
        category: "workspace",
        riskLevel: "low",
        operationType: "read-write",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["owner", "global"],
            description: "owner: notes for the current Space or Workspace. global: cross-project user preferences.",
          },
          content: {
            type: "string",
            description: "The complete new note content in Markdown. Replaces the existing note of this scope.",
          },
          baseVersion: {
            type: "string",
            description:
              "Required after note_conflict: copy currentVersion exactly to acknowledge that you merged the returned currentContent.",
          },
        },
        required: ["scope", "content"],
      },
    },
    execute: (input, context) => executeNoteWrite(
      input,
      context,
      options,
      expectedVersions,
      pendingConflicts,
    ),
  };
}

async function executeNoteWrite(
  input: unknown,
  _context: ToolExecutionContext,
  options: NoteToolOptions,
  expectedVersions: {
    global: AgentNoteVersion;
    owner: { readonly scope: AgentNoteOwner; version: AgentNoteVersion };
  } | undefined,
  pendingConflicts: Partial<Record<"global" | "owner", AgentNotebook>>,
): Promise<unknown> {
  const record = asRecord(input);
  const scopeKind = stringOrUndefined(record.scope);
  const content = typeof record.content === "string" ? record.content : undefined;
  const baseVersion = stringOrUndefined(record.baseVersion);

  if (scopeKind !== "owner" && scopeKind !== "global") {
    return { status: "invalid_input", message: 'scope must be "owner" or "global".' };
  }
  if (content === undefined) {
    return { status: "invalid_input", message: "content must be a string containing the complete note." };
  }

  if (scopeKind === "owner" && options.owner === undefined) {
    return {
      status: "memory_scope_unavailable",
      scope: "owner",
      message: "This tool has no frozen conversation owner and cannot write owner-scoped notes.",
    };
  }
  const scope: AgentNoteScope = scopeKind === "global" ? { kind: "global" } : options.owner!;

  if (expectedVersions === undefined) {
    return {
      status: "note_baseline_unavailable",
      scope: scopeKind,
      message: "This run has no frozen note versions, so NoteWrite cannot replace a note safely. Do not retry in this run.",
    };
  }

  const pendingConflict = pendingConflicts[scopeKind];
  if (pendingConflict !== undefined && baseVersion !== pendingConflict.version) {
    return noteConflictOutput(
      "note_conflict_acknowledgement_required",
      scopeKind,
      pendingConflict,
      "Copy currentVersion into baseVersion only after merging currentContent with your intended revision.",
    );
  }
  const expectedVersionForScope = scopeKind === "global"
    ? expectedVersions.global
    : expectedVersions.owner.version;
  if (pendingConflict === undefined && baseVersion !== undefined && baseVersion !== expectedVersionForScope) {
    return {
      status: "note_base_version_mismatch",
      scope: scopeKind,
      message: "baseVersion does not match this run's current note baseline. Read the latest conflict result before retrying.",
    };
  }
  const expectedVersion = pendingConflict?.version ?? expectedVersionForScope;

  try {
    const result = await options.notes.commands.write({
      scope,
      content,
      expectedVersion,
    });
    if (result.status === "conflict") {
      pendingConflicts[scopeKind] = result.current;
      return noteConflictOutput(
        "note_conflict",
        scopeKind,
        result.current,
        "The note changed after this run started. Merge currentContent with your intended revision, then retry with currentVersion as baseVersion.",
      );
    }
    if (scopeKind === "global") {
      expectedVersions.global = result.notebook.version;
    } else {
      expectedVersions.owner = { scope: options.owner!, version: result.notebook.version };
    }
    if (pendingConflict !== undefined && pendingConflicts[scopeKind]?.version === pendingConflict.version) {
      delete pendingConflicts[scopeKind];
    }
    return {
      status: "saved",
      scope: scopeKind,
      characters: result.notebook.content.length,
      version: result.notebook.version,
      updatedAt: result.notebook.updatedAt,
    };
  } catch (error) {
    if (error instanceof AgentNotesError && error.code === "note_too_large") {
      return { status: "note_too_large", message: error.message };
    }
    if (error instanceof AgentNotesError && error.code === "note_owner_deleted") {
      return {
        status: "memory_owner_deleted",
        scope: scopeKind,
        message: error.message,
      };
    }
    throw error;
  }
}

function noteConflictOutput(
  status: "note_conflict" | "note_conflict_acknowledgement_required",
  scope: "global" | "owner",
  current: AgentNotebook,
  message: string,
): unknown {
  return {
    status,
    scope,
    currentContent: current.content,
    currentVersion: current.version,
    currentUpdatedAt: current.updatedAt,
    message,
  };
}
