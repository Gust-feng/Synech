/**
 * Agent 笔记（模型自主记忆）的公开契约。
 *
 * 笔记是模型自己撰写并沉淀的自然语言记忆（ADR-0033）：模型判断什么值得记、
 * 怎么组织；工程只提供存储、大小边界、启动注入和用户可见可删的机械能力。
 * 笔记不是执行流水档案；流水属于 Ordinary Run 的运行事实或审计材料。
 */

import type { MemoryOwner } from "../../domain/memory/index.js";

/**
 * 会话 owner 级笔记作用域。
 *
 * `id` 是 Space / Workspace feature 持有的稳定软件对象身份，而不是当前挂载路径。
 * 路径只能用于某一轮执行根解析，不能决定跨 run 的记忆归属：Workspace 重挂载、同一路径
 * 换成新对象或 Space 引用同一 Workspace 都不应让笔记漂移。
 */
export type AgentNoteOwner = Exclude<MemoryOwner, { readonly kind: "global" }>;

/** 笔记作用域：全局偏好，或属于一个固定 Space / Workspace owner 的局部记忆。 */
export type AgentNoteScope = MemoryOwner;

/**
 * Runtime guard for the public note facade. TypeScript callers normally carry
 * `AgentNoteScope`, but Panel/host adapters and persisted JSON can still cross
 * this boundary as unknown data. Keeping the owner discriminator checked here
 * prevents a malformed `kind` from becoming a filesystem path segment.
 */
export function assertAgentNoteScope(value: unknown): asserts value is AgentNoteScope {
  const candidate = value as { readonly kind?: unknown; readonly id?: unknown } | null | undefined;
  const valid = candidate !== null && candidate !== undefined &&
    (candidate.kind === "global"
      ? candidate.id === undefined
      : (candidate.kind === "space" || candidate.kind === "workspace") &&
        typeof candidate.id === "string" && candidate.id.length > 0);
  if (!valid) {
    throw new AgentNotesError(
      "note_invalid_owner",
      "Agent note scope must be global or a concrete Space/Workspace owner.",
    );
  }
}

/** 正文内容派生的版本；用户直接编辑 Markdown 后也会立即形成新版本。 */
export type AgentNoteVersion = `sha256:${string}`;

/** 单本笔记的当前内容与元数据。 */
export type AgentNotebook = {
  readonly scope: AgentNoteScope;
  /** 模型撰写的 Markdown 正文；空串表示还没有笔记。 */
  readonly content: string;
  readonly version: AgentNoteVersion;
  readonly updatedAt: string | undefined;
};

/**
 * 与一次 Ordinary run 启动时所见正文严格对应的两本笔记版本。
 *
 * 当前 run 可见的局部笔记固定为 `owner.scope`；模型端只能将它称为 `owner`，
 * 不接收任意 Space / Workspace id 作为工具参数。
 */
export type AgentNoteVersions = {
  readonly global: AgentNoteVersion;
  readonly owner: {
    readonly scope: AgentNoteOwner;
    readonly version: AgentNoteVersion;
  };
};

export type AgentNotesStartupSnapshot = {
  readonly injection: string | undefined;
  readonly versions: AgentNoteVersions;
};

export type AgentNoteWriteInput = {
  readonly scope: AgentNoteScope;
  readonly content: string;
  readonly expectedVersion: AgentNoteVersion;
};

export type AgentNoteRepositoryWriteInput = AgentNoteWriteInput & {
  readonly updatedAt: string;
};

export type AgentNoteWriteResult =
  | { readonly status: "saved"; readonly notebook: AgentNotebook }
  | { readonly status: "conflict"; readonly current: AgentNotebook };

export type AgentNoteDeleteInput = {
  readonly scope: AgentNoteScope;
  readonly expectedVersion: AgentNoteVersion;
};

export type AgentNoteDeleteResult =
  | { readonly status: "deleted"; readonly notebook: AgentNotebook }
  | { readonly status: "conflict"; readonly current: AgentNotebook };

/**
 * 单本笔记的大小上限（字符）。
 *
 * 这是注入成本的机械边界，不是内容规则：超限时写入失败并明确告知模型，
 * 由模型自己整理精简（对应 Claude Code 只注入 MEMORY.md 前 200 行的同类约束，
 * 我们选择让模型收到显式失败而不是被静默截断）。
 */
export const AGENT_NOTE_MAX_CHARS = 20_000;

/** 笔记存储端口：feature 拥有语义，存储实现只做机械读写。 */
export interface AgentNoteRepository {
  read(scope: AgentNoteScope): Promise<AgentNotebook>;
  write(input: AgentNoteRepositoryWriteInput): Promise<AgentNoteWriteResult>;
  /** Physically remove one notebook after an exact content-version check. */
  delete(input: AgentNoteDeleteInput): Promise<AgentNoteDeleteResult>;
  /** Physically remove one concrete Space / Workspace notebook. */
  deleteByOwner(owner: AgentNoteOwner): Promise<void>;
}

/** 笔记功能的公开 facade。 */
export type AgentNotesFeature = {
  readonly queries: {
    /** 读取一本笔记；从未写过时返回空内容。 */
    get(scope: AgentNoteScope): Promise<AgentNotebook>;
    /**
     * 同一次读取组装全局和当前 owner 的启动注入文本与对应版本，避免 run birth 冻结错位。
     * 两本都为空时 injection 为 undefined，版本仍对应空正文。
     */
    startupSnapshot(owner: AgentNoteOwner): Promise<AgentNotesStartupSnapshot>;
  };
  readonly commands: {
    /**
     * 全量替换一本笔记。模型每次提交完整笔记正文——这让"整理、合并、删旧"
     * 成为模型的普通编辑动作，而不需要工程提供 append/merge 语义。
     */
    write(input: AgentNoteWriteInput): Promise<AgentNoteWriteResult>;
    /** Physically delete one global or owner notebook after a CAS check. */
    delete(input: AgentNoteDeleteInput): Promise<AgentNoteDeleteResult>;
    /**
     * Delete the notebook owned by one concrete Space / Workspace.
     * Global notes are intentionally not representable by this command.
     */
    deleteByOwner(owner: AgentNoteOwner): Promise<void>;
  };
};

export class AgentNotesError extends Error {
  constructor(
    readonly code: "note_too_large" | "note_io_failure" | "note_invalid_owner" | "note_owner_deleted",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AgentNotesError";
  }
}
