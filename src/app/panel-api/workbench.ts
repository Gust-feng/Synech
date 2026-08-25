/**
 * Panel HTTP API 共享契约类型。
 *
 * 本文件定义 Panel 前后端共用的 API 响应/实体类型。
 * 后端路由和前端 client 都从这里引用，消除手动镜像。
 *
 * 只放纯类型，不放运行时代码。
 */

/* ─── Personal Knowledge ─────────────────────────────────────────── */

export type PersonalNoteRevision = {
  readonly noteId: string;
  readonly revision: number;
  readonly baseRevision?: number;
  readonly operation: "create" | "update" | "delete" | "snapshot";
  readonly title: string;
  readonly bodyMarkdown: string;
  readonly actor: {
    readonly kind: "user" | "agent" | "system";
    readonly actorId?: string;
    readonly traceId?: string;
    readonly goalId?: string;
    readonly toolCallId?: string;
  };
  readonly changeSummary?: string;
  readonly createdAt: number;
};

/* --- Workbench projection changes ------------------------------------ */

/** Identifies a Panel projection whose authoritative backend facts changed. */
export type WorkbenchProjectionOwner =
  | "spaces"
  | "workspaces"
  | "managed_assets"
  | "mounted_files"
  | "personal_knowledge"
  | "conversations";

/**
 * Live invalidation fact. It deliberately carries no business snapshot: each
 * consumer must re-read the feature that owns the changed data.
 */
export type WorkbenchProjectionChange = {
  readonly revision: number;
  readonly owners: readonly WorkbenchProjectionOwner[];
  readonly reset: boolean;
  readonly spaceIds?: readonly string[];
  readonly referenceIds?: readonly string[];
  readonly noteIds?: readonly string[];
  readonly managedAssetIds?: readonly string[];
  /** 会话事实变化；消费方需重读会话投影。 */
  readonly conversationIds?: readonly string[];
};

/* ─── Document Preview ───────────────────────────────────────────── */

import type { SpaceReferenceAnnotation } from "./spaces.js";

export type DocumentPresentation = {
  readonly kind: "directory" | "markdown" | "code" | "text" | "image" | "pdf" | "docx" | "xlsx" | "video" | "audio" | "web" | "unavailable";
  readonly editable: boolean;
  readonly sourceMode: boolean;
};

export type DocumentSourceKind =
  | "local_file"
  | "workspace"
  | "managed_folder"
  | "knowledge_asset"
  | "asset_folder"
  | "managed_asset"
  | "web_page"
  | "generated_artifact"
  | "conversation";

export type DocumentTextUpdateInput = {
  readonly relativePath?: string;
  readonly expectedFingerprint: string;
  readonly text: string;
};

export type DocumentCaptionUpdateInput = {
  readonly relativePath?: string;
  readonly expectedFingerprint: string;
  readonly caption: string;
};

export type DocumentPreview = {
  readonly itemId: string;
  readonly title: string;
  readonly sourceKind: DocumentSourceKind;
  readonly source: string;
  readonly status: "ready" | "missing" | "unsupported";
  readonly presentation: DocumentPresentation;
  readonly fingerprint?: string;
  readonly byteLength?: number;
  readonly modifiedAt?: number;
  /** Space 引用的 Agent/用户整理内容（额外展示字段）。它属于 Space，不是来源正文，不能覆盖 content 中的源事实。 */
  readonly annotation?: SpaceReferenceAnnotation;
  readonly content:
    | { readonly kind: "text"; readonly text: string; readonly truncated: boolean; readonly editable: boolean; readonly language?: string; readonly encoding?: string }
    | { readonly kind: "directory"; readonly relativePath: string; readonly entries: readonly { readonly name: string; readonly relativePath: string; readonly kind: "file" | "directory" | "other" }[]; readonly truncated: boolean }
    | { readonly kind: "media"; readonly mediaKind: "image" | "pdf" | "video" | "audio"; readonly mimeType: string; readonly url: string; readonly alt?: string; readonly caption?: string; readonly captionEditable?: boolean; readonly captionFingerprint?: string; readonly poster?: string; readonly duration?: string; readonly transcript?: string }
    | { readonly kind: "office"; readonly officeKind: "docx" | "xlsx"; readonly mimeType: string; readonly url: string }
    | { readonly kind: "pages"; readonly pages: readonly string[] }
    | { readonly kind: "web"; readonly url: string; readonly site?: string; readonly body?: string }
    | { readonly kind: "unavailable"; readonly message: string };
};
