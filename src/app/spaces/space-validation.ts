import { z } from "zod";

import {
  SPACE_TREE_SCHEMA_VERSION,
  SpaceFeatureError,
  type SpaceReference,
  type SpaceReferenceAnnotation,
  type SpaceReferenceImageCaption,
  type SpaceTreeSnapshot,
} from "./contracts.js";
import { toPersistedJsonShape } from "../../kernel/values/index.js";

/**
 * annotation 是有界产品内容，不是网页快照：Markdown 沿用文本资产的
 * 512 KiB 有界策略，keyPoints/tags 有明确的数组长度与单项长度上限。
 * 超出上限时校验明确失败，绝不截断后声称保存成功。
 */
export const MAX_SPACE_REFERENCE_ANNOTATION_MARKDOWN_LENGTH = 512 * 1024;
export const MAX_SPACE_REFERENCE_ANNOTATION_KEY_POINTS = 32;
export const MAX_SPACE_REFERENCE_ANNOTATION_KEY_POINT_LENGTH = 512;
export const MAX_SPACE_REFERENCE_ANNOTATION_TAGS = 32;
export const MAX_SPACE_REFERENCE_ANNOTATION_TAG_LENGTH = 64;
export const MAX_SPACE_REFERENCE_IMAGE_CAPTION_LENGTH = 16 * 1024;

export const spaceReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local_file"), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("workspace"), workspaceId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("managed_folder"), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("asset_folder") }).strict(),
  z.object({ kind: z.literal("managed_asset"), assetId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("web_page"), url: z.string().url() }).strict(),
  z.object({ kind: z.literal("generated_artifact"), artifactRef: z.string().min(1) }).strict(),
]);

/** 持久化/读模型中的完整 annotation 事实；revision、时间与 actor 由 SpaceFeature 生成。 */
export const spaceReferenceActorRecordSchema = z.object({
  kind: z.enum(["agent", "user"]),
  actorId: z.string().min(1).max(256).optional(),
  traceId: z.string().min(1).max(256).optional(),
  goalId: z.string().min(1).max(256).optional(),
  toolCallId: z.string().min(1).max(256).optional(),
}).strict();

export const spaceReferenceAnnotationSchema = z.object({
  markdown: z.string().min(1).max(MAX_SPACE_REFERENCE_ANNOTATION_MARKDOWN_LENGTH),
  keyPoints: z.array(z.string().min(1).max(MAX_SPACE_REFERENCE_ANNOTATION_KEY_POINT_LENGTH)).max(MAX_SPACE_REFERENCE_ANNOTATION_KEY_POINTS).optional(),
  tags: z.array(z.string().min(1).max(MAX_SPACE_REFERENCE_ANNOTATION_TAG_LENGTH)).max(MAX_SPACE_REFERENCE_ANNOTATION_TAGS).optional(),
  revision: z.number().int().min(1),
  updatedAt: z.string().min(1),
  updatedBy: z.enum(["agent", "user"]),
  actor: spaceReferenceActorRecordSchema,
}).strict();

export const spaceReferenceImageCaptionSchema = z.object({
  text: z.string().max(MAX_SPACE_REFERENCE_IMAGE_CAPTION_LENGTH),
  revision: z.number().int().min(1),
  updatedAt: z.string().min(1),
  updatedBy: z.enum(["agent", "user"]),
  actor: spaceReferenceActorRecordSchema,
}).strict();

export const spaceReferenceImageCaptionsSchema = z.record(
  z.string().max(4_096),
  spaceReferenceImageCaptionSchema,
);

const spaceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();

const referenceItemSchema = z.object({
  id: z.string().min(1),
  spaceId: z.string().min(1),
  title: z.string().min(1),
  parentId: z.string().min(1).optional(),
  reference: spaceReferenceSchema,
  sourceIdentity: z.string().min(1).optional(),
  annotation: spaceReferenceAnnotationSchema.optional(),
  imageCaptions: spaceReferenceImageCaptionsSchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();

const snapshotSchema = z.object({
  schemaVersion: z.literal(SPACE_TREE_SCHEMA_VERSION),
  spaces: z.array(spaceSchema),
  referenceItems: z.array(referenceItemSchema),
}).strict().superRefine((snapshot, context) => {
  const ids = new Set<string>();
  for (const [collection, entries] of [["spaces", snapshot.spaces], ["referenceItems", snapshot.referenceItems]] as const) {
    for (const [index, entry] of entries.entries()) {
      if (ids.has(entry.id)) {
        context.addIssue({ code: "custom", path: [collection, index, "id"], message: "ids must be unique across a SpaceTree snapshot" });
      }
      ids.add(entry.id);
    }
  }
  const spaceIds = new Set(snapshot.spaces.map((space) => space.id));
  for (const [index, item] of snapshot.referenceItems.entries()) {
    if (!spaceIds.has(item.spaceId)) {
      context.addIssue({ code: "custom", path: ["referenceItems", index, "spaceId"], message: "reference item space must exist" });
    }
    if (item.parentId !== undefined) {
      const parent = snapshot.referenceItems.find((candidate) => candidate.id === item.parentId);
      if (parent === undefined || parent.spaceId !== item.spaceId) {
        context.addIssue({ code: "custom", path: ["referenceItems", index, "parentId"], message: "reference parent must exist in the same Space" });
      }
    }
  }
});

export function validateSpaceTreeSnapshot(snapshot: unknown): SpaceTreeSnapshot {
  const result = snapshotSchema.safeParse(snapshot);
  if (!result.success) {
    throw new SpaceFeatureError("space_snapshot_incompatible", `SpaceTree snapshot is invalid: ${z.prettifyError(result.error)}`);
  }
  return toPersistedJsonShape(result.data);
}

/** Validate the opaque edge, never by reading or resolving its external target. */
export function validateSpaceReference(reference: SpaceReference): SpaceReference {
  const result = spaceReferenceSchema.safeParse(reference);
  if (!result.success) {
    throw new SpaceFeatureError("space_invalid_input", `Space reference is invalid: ${z.prettifyError(result.error)}`);
  }
  return toPersistedJsonShape(result.data);
}

/**
 * 校验完整 annotation 事实。结构错误返回 `space_reference_annotation_invalid`，
 * 超出边界（Markdown 长度、数组长度或单项长度）返回
 * `space_reference_annotation_too_large`，两者都明确失败且不截断。
 */
export function validateSpaceReferenceAnnotation(annotation: SpaceReferenceAnnotation): SpaceReferenceAnnotation {
  const result = spaceReferenceAnnotationSchema.safeParse(annotation);
  if (!result.success) {
    const tooLarge = result.error.issues.some((issue) => issue.code === "too_big");
    throw new SpaceFeatureError(
      tooLarge ? "space_reference_annotation_too_large" : "space_reference_annotation_invalid",
      `Space reference annotation is ${tooLarge ? "too large" : "invalid"}: ${z.prettifyError(result.error)}`,
    );
  }
  return toPersistedJsonShape(result.data);
}

export function validateSpaceReferenceImageCaption(caption: SpaceReferenceImageCaption): SpaceReferenceImageCaption {
  const result = spaceReferenceImageCaptionSchema.safeParse(caption);
  if (!result.success) {
    const tooLarge = result.error.issues.some((issue) => issue.code === "too_big");
    throw new SpaceFeatureError(
      tooLarge ? "space_reference_image_caption_too_large" : "space_reference_image_caption_invalid",
      `Space reference image caption is ${tooLarge ? "too large" : "invalid"}: ${z.prettifyError(result.error)}`,
    );
  }
  return toPersistedJsonShape(result.data);
}
