export type PersonalNote = {
  readonly id: string;
  /** Optional organization link. Knowledge remains alive when its source Space is deleted. */
  readonly spaceId?: string;
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
};

export type PersonalKnowledgeActor = {
  readonly kind: "user" | "agent" | "system";
  readonly actorId?: string;
  readonly traceId?: string;
  readonly goalId?: string;
  readonly toolCallId?: string;
};

export type PersonalNoteRevision = {
  readonly noteId: string;
  readonly revision: number;
  readonly baseRevision?: number;
  readonly operation: "create" | "update" | "delete" | "snapshot";
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly actor: PersonalKnowledgeActor;
  readonly changeSummary?: string;
  readonly createdAt: number;
};

export type KnowledgePage = {
  readonly refId: string;
  readonly kind: "note" | "space_reference";
  readonly collectedAt: number;
  readonly asset?: {
    readonly status: "managed";
    readonly title: string;
    readonly sourceLabel: string;
    readonly contentKind: "file" | "directory";
    readonly sourceReferenceId?: string;
    readonly sourceRelativePath?: string;
  };
};

/** Agent 可操作的 Personal Knowledge 页面概览。 */
export type KnowledgePageSummary = {
  readonly refId: string;
  readonly kind: KnowledgePage["kind"];
  readonly title?: string;
  /** 笔记所属 Space id；只有 kind 为 note 的页面携带。 */
  readonly spaceId?: string;
  readonly collectedAt: number;
};

export type KnowledgeListQuery = {
  readonly query?: string;
  readonly kind?: "note" | "space_reference";
  readonly spaceId?: string;
  readonly themeId?: string;
  readonly limit?: number;
  readonly cursor?: string;
};

export type KnowledgeListResult = {
  readonly pages: readonly KnowledgePageSummary[];
  readonly themes: readonly KnowledgeTheme[];
  readonly assignments: readonly KnowledgeThemeAssignment[];
  readonly nextInput?: KnowledgeListQuery;
};

/**
 * 托管知识资产读取端口的结果，表达 feature-owned 内容事实。
 * 具体路径解析、MIME、目录扫描和文本分段由 Host/中性文件能力实现。
 */
export type KnowledgeAssetReadResult =
  | { readonly status: "directory"; readonly relativePath: string; readonly entries: readonly { readonly name: string; readonly relativePath: string; readonly kind: "file" | "directory" | "other" }[]; readonly truncated: boolean; readonly continuation?: string }
  | { readonly status: "text"; readonly relativePath: string; readonly text: string; readonly truncated: boolean; readonly fingerprint: string; readonly byteLength: number; readonly language?: string; readonly continuation?: string }
  | { readonly status: "media"; readonly relativePath: string; readonly mediaKind: "image" | "pdf" | "video" | "audio"; readonly mimeType: string; readonly byteLength: number; readonly contentUrl: string }
  | { readonly status: "unsupported"; readonly relativePath: string; readonly message: string }
  | { readonly status: "missing"; readonly relativePath: string; readonly message: string }
  | { readonly status: "invalid"; readonly relativePath: string; readonly message: string };

export type ManagedKnowledgeAssetReadPort = (input: {
  readonly page: KnowledgePage;
  readonly relativePath: string;
  readonly maxLength?: number;
  readonly continuation?: string;
}) => Promise<KnowledgeAssetReadResult>;

export type KnowledgePageReadResult =
  | { readonly status: "note"; readonly refId: string; readonly kind: "note"; readonly title: string; readonly spaceId?: string; readonly bodyMarkdown: string; readonly truncated: boolean; readonly revision: number; readonly continuation?: string }
  | { readonly status: "space_reference"; readonly refId: string; readonly relativePath: string; readonly content: KnowledgeAssetReadResult }
  | { readonly status: "missing"; readonly refId: string; readonly message: string };

export type KnowledgeLink = { readonly from: string; readonly to: string };

/** Personal Knowledge 长期业务变更的 append-only 审计记录，不复制工具结果与正文。 */
export type PersonalKnowledgeChangeRecord =
  | { readonly id: string; readonly type: "knowledge.asset_updated"; readonly refId: string; readonly relativePath: string; readonly beforeFingerprint: string; readonly afterFingerprint: string; readonly actor: PersonalKnowledgeActor; readonly occurredAt: number }
  | { readonly id: string; readonly type: "knowledge.uncollected"; readonly refId: string; readonly kind: KnowledgePage["kind"]; readonly actor: PersonalKnowledgeActor; readonly occurredAt: number }
  | { readonly id: string; readonly type: "knowledge.theme_created"; readonly themeId: string; readonly name: string; readonly actor: PersonalKnowledgeActor; readonly occurredAt: number }
  | { readonly id: string; readonly type: "knowledge.theme_assigned"; readonly themeId: string; readonly refIds: readonly string[]; readonly actor: PersonalKnowledgeActor; readonly occurredAt: number }
  | { readonly id: string; readonly type: "knowledge.theme_unassigned"; readonly themeId: string; readonly refIds: readonly string[]; readonly actor: PersonalKnowledgeActor; readonly occurredAt: number };

export type KnowledgeTheme = {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly origin: "agent" | "user";
};

export type KnowledgeThemeAssignment = {
  readonly refId: string;
  readonly themeId: string;
  readonly by: "agent" | "user";
  readonly locked: boolean;
};

export type PersonalKnowledgeSnapshot = {
  readonly notes: readonly PersonalNote[];
  readonly pages: readonly KnowledgePage[];
  readonly links: readonly KnowledgeLink[];
  readonly themes: readonly KnowledgeTheme[];
  readonly assignments: readonly KnowledgeThemeAssignment[];
  readonly recentlyOpened: Readonly<Record<string, number>>;
};

export type PersonalKnowledgeSearchResult = {
  readonly note: Omit<PersonalNote, "bodyMarkdown">;
  readonly snippet: string;
};

export type PersonalKnowledgeEvent =
  | { readonly type: "personal_knowledge.note_created"; readonly noteId: string; readonly spaceId?: string }
  | { readonly type: "personal_knowledge.note_updated"; readonly noteId: string }
  | { readonly type: "personal_knowledge.note_deleted"; readonly noteId: string }
  | { readonly type: "personal_knowledge.changed"; readonly refIds?: readonly string[] };

export type PersonalKnowledgeCommand =
  | { readonly type: "note.create"; readonly note: PersonalNote; readonly actor: PersonalKnowledgeActor; readonly changeSummary?: string }
  | { readonly type: "note.update"; readonly id: string; readonly expectedRevision: number; readonly title?: string; readonly bodyMarkdown?: string; readonly updatedAt: number; readonly actor: PersonalKnowledgeActor; readonly changeSummary?: string }
  | { readonly type: "note.delete"; readonly id: string; readonly expectedRevision: number; readonly deletedAt: number; readonly actor: PersonalKnowledgeActor; readonly changeSummary?: string }
  | { readonly type: "note.reorder"; readonly orderedIds: readonly string[] }
  | { readonly type: "knowledge.collect"; readonly page: KnowledgePage }
  | { readonly type: "knowledge.uncollect"; readonly refId: string }
  | { readonly type: "knowledge.link_add"; readonly link: KnowledgeLink }
  | { readonly type: "knowledge.link_remove"; readonly link: KnowledgeLink }
  | { readonly type: "knowledge.opened"; readonly refId: string; readonly openedAt: number }
  | { readonly type: "space.cleanup"; readonly spaceId: string; readonly referenceIds: readonly string[] }
  | { readonly type: "theme.create"; readonly theme: KnowledgeTheme }
  | { readonly type: "theme.rename"; readonly themeId: string; readonly name: string }
  | { readonly type: "theme.delete"; readonly themeId: string }
  | { readonly type: "theme.merge"; readonly fromId: string; readonly toId: string }
  | { readonly type: "theme.assign"; readonly assignment: KnowledgeThemeAssignment }
  | { readonly type: "theme.unassign"; readonly refId: string; readonly themeId: string }
  | { readonly type: "theme.toggle_lock"; readonly refId: string; readonly themeId: string }
  | { readonly type: "theme.replace"; readonly theme: KnowledgeTheme };

export interface PersonalKnowledgeRepository {
  readSnapshot(): Promise<PersonalKnowledgeSnapshot>;
  getNote(id: string): Promise<PersonalNote | undefined>;
  listNoteRevisions(id: string, limit: number): Promise<readonly PersonalNoteRevision[]>;
  /** 读取指定 revision 的完整快照；不存在时返回 undefined。 */
  getNoteRevision(id: string, revision: number): Promise<PersonalNoteRevision | undefined>;
  searchNotes(input: { readonly query: string; readonly spaceId?: string; readonly limit: number }): Promise<readonly PersonalKnowledgeSearchResult[]>;
  listPages(input: KnowledgeListQuery): Promise<{ readonly pages: readonly KnowledgePageSummary[]; readonly nextCursor?: string }>;
  recentChanges(input: { readonly refId?: string; readonly themeId?: string; readonly limit: number; readonly cursor?: string }): Promise<{ readonly records: readonly PersonalKnowledgeChangeRecord[]; readonly nextCursor?: string }>;
  appendChangeRecord(record: PersonalKnowledgeChangeRecord): Promise<void>;
  assignTheme(input: { readonly themeId: string; readonly refIds: readonly string[]; readonly by: "agent" | "user" }): Promise<{ readonly assigned: readonly string[]; readonly unchanged: readonly string[] }>;
  unassignTheme(input: { readonly themeId: string; readonly refIds: readonly string[] }): Promise<readonly string[]>;
  execute(command: PersonalKnowledgeCommand): Promise<void>;
}

export type PersonalKnowledgeManagedAssetTextUpdate<TWriteResult> = {
  readonly page: KnowledgePage;
  readonly writeResult: TWriteResult;
};

export type PersonalKnowledgeFeature<TManagedAssetTextWriteResult extends { readonly fingerprint?: string } = { readonly fingerprint?: string }> = {
  readonly commands: {
    createNote(input: { readonly id?: string; readonly spaceId?: string; readonly title?: string; readonly bodyMarkdown?: string; readonly actor?: PersonalKnowledgeActor; readonly changeSummary?: string }): Promise<PersonalNote>;
    updateNote(input: { readonly id: string; readonly expectedRevision: number; readonly title?: string; readonly bodyMarkdown?: string; readonly actor?: PersonalKnowledgeActor; readonly changeSummary?: string }): Promise<void>;
    /** 把笔记完整内容恢复到历史 revision，写出新 revision；陈旧 expectedRevision 拒绝。 */
    restoreNote(input: { readonly id: string; readonly expectedRevision: number; readonly targetRevision: number; readonly actor?: PersonalKnowledgeActor; readonly changeSummary?: string }): Promise<void>;
    deleteNote(input: { readonly id: string; readonly expectedRevision: number; readonly actor?: PersonalKnowledgeActor; readonly changeSummary?: string }): Promise<void>;
    reorderNotes(orderedIds: readonly string[]): Promise<void>;
    collectSpaceReference(input: { readonly referenceId: string; readonly relativePath?: string }): Promise<KnowledgePage>;
    updateManagedAssetText(input: {
      readonly refId: string;
      readonly relativePath: string;
      readonly expectedFingerprint: string;
      readonly text: string;
      readonly actor?: PersonalKnowledgeActor;
    }): Promise<PersonalKnowledgeManagedAssetTextUpdate<TManagedAssetTextWriteResult>>;
    uncollect(refId: string, actor?: PersonalKnowledgeActor): Promise<{ readonly managedCopyRemoved: boolean }>;
    createTheme(input: { readonly name: string; readonly actor: PersonalKnowledgeActor }): Promise<{ readonly theme: KnowledgeTheme; readonly created: boolean }>;
    assignTheme(input: { readonly themeId: string; readonly refIds: readonly string[]; readonly actor: PersonalKnowledgeActor }): Promise<{ readonly themeId: string; readonly assigned: readonly string[]; readonly unchanged: readonly string[] }>;
    unassignTheme(input: { readonly themeId: string; readonly refIds: readonly string[]; readonly actor: PersonalKnowledgeActor }): Promise<{ readonly themeId: string; readonly unassigned: readonly string[]; readonly locked: readonly string[] }>;
    /** Detaches notes and copied assets from a deleted Space without deleting Knowledge-owned content. */
    cleanupSpace(input: { readonly spaceId: string; readonly referenceIds: readonly string[] }): Promise<void>;
    execute(command: Exclude<PersonalKnowledgeCommand, {
      readonly type: "note.create" | "note.update" | "note.delete" | "note.reorder" | "knowledge.uncollect" | "space.cleanup";
    }>): Promise<void>;
  };
  readonly queries: {
    snapshot(): Promise<PersonalKnowledgeSnapshot>;
    note(id: string): Promise<PersonalNote | undefined>;
    noteRevisions(id: string, limit?: number): Promise<readonly PersonalNoteRevision[]>;
    search(input: { readonly query: string; readonly spaceId?: string; readonly limit?: number }): Promise<readonly PersonalKnowledgeSearchResult[]>;
    list(input?: KnowledgeListQuery): Promise<KnowledgeListResult>;
    readPage(input: { readonly refId: string; readonly relativePath?: string; readonly maxLength?: number; readonly continuation?: string }): Promise<KnowledgePageReadResult>;
    recentChanges(input?: { readonly refId?: string; readonly themeId?: string; readonly limit?: number; readonly cursor?: string }): Promise<{ readonly records: readonly PersonalKnowledgeChangeRecord[]; readonly nextCursor?: string }>;
  };
  readonly events: { subscribe(listener: (event: PersonalKnowledgeEvent) => void): () => void };
  release(): Promise<void>;
};

export type PersonalKnowledgeErrorCode =
  | "personal_knowledge_released"
  | "personal_knowledge_invalid_input"
  | "personal_note_not_found"
  | "personal_note_revision_conflict"
  | "knowledge_asset_not_found"
  | "knowledge_asset_revision_conflict"
  | "knowledge_asset_source_missing"
  | "knowledge_asset_not_editable"
  | "knowledge_asset_write_failed"
  | "knowledge_theme_not_found"
  | "personal_knowledge_repository_failure";

export class PersonalKnowledgeError extends Error {
  readonly name = "PersonalKnowledgeError";

  constructor(readonly code: PersonalKnowledgeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
