import { z } from "zod";

import type {
  KnowledgeLink,
  KnowledgePage,
  KnowledgeTheme,
  KnowledgeThemeAssignment,
  PersonalKnowledgeActor,
  PersonalKnowledgeChangeRecord,
  PersonalKnowledgeSnapshot,
  PersonalKnowledgeSearchResult,
  PersonalNote,
  PersonalNoteRevision,
} from "./contracts.js";

const id = z.string().min(1);
const timestamp = z.number().finite();
const actorSchema = z.object({
  kind: z.enum(["user", "agent", "system"]),
  actorId: z.string().min(1).optional(),
  traceId: z.string().min(1).optional(),
  goalId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
}).strict();

const noteSchema = z.object({
  id,
  spaceId: id.optional(),
  title: z.string(),
  bodyMarkdown: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  revision: z.number().int().positive(),
}).strict();

const noteRevisionSchema = z.object({
  noteId: id,
  revision: z.number().int().positive(),
  baseRevision: z.number().int().positive().optional(),
  operation: z.enum(["create", "update", "delete", "snapshot"]),
  title: z.string(),
  bodyMarkdown: z.string(),
  actor: actorSchema,
  changeSummary: z.string().optional(),
  createdAt: timestamp,
}).strict();

const knowledgeAssetSchema = z.object({
  status: z.literal("managed"),
  title: z.string(),
  sourceLabel: z.string(),
  contentKind: z.enum(["file", "directory"]),
  sourceReferenceId: id.optional(),
  sourceRelativePath: z.string().optional(),
}).strict();

const pageSchema = z.object({
  refId: id,
  kind: z.enum(["note", "space_reference"]),
  collectedAt: timestamp,
  asset: knowledgeAssetSchema.optional(),
}).strict();

const linkSchema = z.object({ from: id, to: id }).strict().refine(
  (link) => link.from !== link.to,
  { message: "Knowledge link cannot reference itself." },
);
const themeSchema = z.object({
  id,
  name: z.string(),
  color: z.string(),
  origin: z.enum(["agent", "user"]),
}).strict();
const assignmentSchema = z.object({
  refId: id,
  themeId: id,
  by: z.enum(["agent", "user"]),
  locked: z.boolean(),
}).strict();

const changeRecordSchema = z.discriminatedUnion("type", [
  z.object({
    id,
    type: z.literal("knowledge.asset_updated"),
    refId: id,
    relativePath: z.string(),
    beforeFingerprint: z.string(),
    afterFingerprint: z.string(),
    actor: actorSchema,
    occurredAt: timestamp,
  }).strict(),
  z.object({
    id,
    type: z.literal("knowledge.uncollected"),
    refId: id,
    kind: z.enum(["note", "space_reference"]),
    actor: actorSchema,
    occurredAt: timestamp,
  }).strict(),
  z.object({
    id,
    type: z.literal("knowledge.theme_created"),
    themeId: id,
    name: z.string(),
    actor: actorSchema,
    occurredAt: timestamp,
  }).strict(),
  z.object({
    id,
    type: z.literal("knowledge.theme_assigned"),
    themeId: id,
    refIds: z.array(id),
    actor: actorSchema,
    occurredAt: timestamp,
  }).strict(),
  z.object({
    id,
    type: z.literal("knowledge.theme_unassigned"),
    themeId: id,
    refIds: z.array(id),
    actor: actorSchema,
    occurredAt: timestamp,
  }).strict(),
]);

const snapshotSchema = z.object({
  notes: z.array(noteSchema),
  pages: z.array(pageSchema),
  links: z.array(linkSchema),
  themes: z.array(themeSchema),
  assignments: z.array(assignmentSchema),
  recentlyOpened: z.record(id, timestamp),
}).strict();
const searchResultSchema = z.object({
  note: noteSchema.omit({ bodyMarkdown: true }),
  snippet: z.string(),
}).strict();
const noteListRowSchema = z.object({
  id,
  title: z.string(),
  spaceId: id.optional(),
  createdAt: timestamp,
}).strict();
const assignmentIdentitySchema = z.object({ refId: id, themeId: id }).strict();

export function parsePersonalNote(value: unknown): PersonalNote {
  return noteSchema.parse(value);
}

export function parsePersonalNoteRevision(value: unknown): PersonalNoteRevision {
  return noteRevisionSchema.parse(value);
}

export function parseKnowledgePage(value: unknown): KnowledgePage {
  return pageSchema.parse(value);
}

export function parseKnowledgeAsset(value: unknown): NonNullable<KnowledgePage["asset"]> {
  return knowledgeAssetSchema.parse(value);
}

export function parseKnowledgeLink(value: unknown): KnowledgeLink {
  return linkSchema.parse(value);
}

export function parseKnowledgeTheme(value: unknown): KnowledgeTheme {
  return themeSchema.parse(value);
}

export function parseKnowledgeThemeAssignment(value: unknown): KnowledgeThemeAssignment {
  return assignmentSchema.parse(value);
}

export function parsePersonalKnowledgeChangeRecord(value: unknown): PersonalKnowledgeChangeRecord {
  return changeRecordSchema.parse(value);
}

export function parsePersonalKnowledgeSnapshot(value: unknown): PersonalKnowledgeSnapshot {
  return snapshotSchema.parse(value);
}

export function parsePersonalKnowledgeSearchResult(value: unknown): PersonalKnowledgeSearchResult {
  return searchResultSchema.parse(value);
}

export function parseKnowledgeNoteListRow(value: unknown): {
  readonly id: string;
  readonly title: string;
  readonly spaceId?: string;
  readonly createdAt: number;
} {
  return noteListRowSchema.parse(value);
}

export function parseKnowledgeAssignmentIdentity(value: unknown): {
  readonly refId: string;
  readonly themeId: string;
} {
  return assignmentIdentitySchema.parse(value);
}

export function parsePersonalKnowledgeActor(value: unknown): PersonalKnowledgeActor {
  return actorSchema.parse(value);
}
