import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SqliteRuntimeDatabase } from "../../../adapters/runtime-storage/index.js";
import type { DocumentPreview } from "../../panel-api/workbench.js";
import type { ManagedAssetRepository } from "../../managed-assets/index.js";
import type { KnowledgePage, PersonalKnowledgeFeature } from "../../personal-knowledge/index.js";
import type { SpaceFeature, SpaceReferenceActorRecord, SpaceReferenceItem } from "../../spaces/index.js";
import {
  DEFAULT_SPACE_ID,
  INITIAL_KNOWLEDGE_ASSIGNMENTS,
  INITIAL_KNOWLEDGE_COLLECTIONS,
  INITIAL_KNOWLEDGE_LINKS,
  INITIAL_KNOWLEDGE_THEMES,
  INITIAL_WORKBENCH_MANAGED_FOLDERS,
  INITIAL_WORKBENCH_NOTES,
  INITIAL_WORKBENCH_SPACES,
  INITIAL_WORKBENCH_WEB_REFERENCES,
  type InitialWorkbenchFileDefinition,
  type InitialWorkbenchManagedFolderDefinition,
  type InitialWorkbenchNoteDefinition,
} from "./initial-workbench-content.js";
import { createManagedSpaceFolder, deleteManagedSpaceFolder } from "../../application/managed-space-folder-store.js";
import { ensureDefaultSpace } from "./default-space-initializer.js";

/**
 * A fresh installation receives ordinary Space data, not a parallel demo
 * projection. Built-in files live in the same managed folders created from the
 * Space UI, and Knowledge captures them through the public collection command.
 */
export const INITIAL_WORKBENCH_DATA_KEY = "synech-initial-space/v1";
export const INITIAL_SPACE_ID = DEFAULT_SPACE_ID;
export const INITIAL_BUILTIN_DATA_ELIGIBILITY_KEY = "synech-initial-content-eligible/v1";
export const INITIAL_BUILTIN_DATA_KEY = "synech-initial-content/v1";
const INITIAL_ASSET_ROOT = fileURLToPath(new URL("./initial-workbench-assets/", import.meta.url));
const INITIAL_SPACE_ACTOR: SpaceReferenceActorRecord = { kind: "agent", actorId: "synech-initial-content" };

type InitialKnowledgeCollectionKey = typeof INITIAL_KNOWLEDGE_COLLECTIONS[number]["key"];

export type InitialWorkbenchDataInitializer = {
  ensure(): Promise<void>;
};

/** Shares one active initialization attempt and permits a later retry after failure. */
export function createInitialWorkbenchDataInitializer(
  initialize: () => Promise<void>,
): InitialWorkbenchDataInitializer {
  let completed = false;
  let active: Promise<void> | undefined;
  return {
    ensure() {
      if (completed) return Promise.resolve();
      if (active !== undefined) return active;
      const attempt = initialize().then(() => {
        completed = true;
      }).finally(() => {
        if (active === attempt) active = undefined;
      });
      active = attempt;
      return attempt;
    },
  };
}

export async function initializeInitialWorkbenchData(input: {
  readonly database: SqliteRuntimeDatabase;
  readonly spaceFeature: SpaceFeature;
  readonly personalKnowledgeFeature: PersonalKnowledgeFeature<DocumentPreview>;
  /** Existing managed assets make the store user-owned and therefore ineligible for seeding. */
  readonly managedAssets: ManagedAssetRepository;
  readonly managedSpaceRoot: string;
  readonly managedSpaceFolderRoot: string;
}): Promise<void> {
  const initialContentEligible = await ensureInitialContentEligibility(input);

  if (!input.database.hasInitialization(INITIAL_WORKBENCH_DATA_KEY)) {
    await ensureDefaultSpace({ spaceFeature: input.spaceFeature, managedSpaceRoot: input.managedSpaceRoot });
    input.database.recordInitialization(INITIAL_WORKBENCH_DATA_KEY);
  }

  if (!initialContentEligible || hasCompletedInitialContent(input.database)) return;

  for (const space of INITIAL_WORKBENCH_SPACES) {
    await ensureSpace(input.spaceFeature, space.id, space.title);
    await ensureSpaceManagedRoot(input.managedSpaceRoot, space.id);
  }

  for (const definition of INITIAL_WORKBENCH_WEB_REFERENCES) {
    await ensureInitialWebReference(input.spaceFeature, definition);
  }
  // SpaceFeature prepends new references. Create the desired display order in
  // reverse so the initial tree matches the order declared by the data source.
  for (const definition of [...INITIAL_WORKBENCH_MANAGED_FOLDERS].reverse()) {
    await ensureInitialManagedFolder(input, definition);
  }

  const collectedPages = new Map<InitialKnowledgeCollectionKey, KnowledgePage>();
  for (const collection of INITIAL_KNOWLEDGE_COLLECTIONS) {
    const page = await input.personalKnowledgeFeature.commands.collectSpaceReference({
      referenceId: collection.referenceId,
      relativePath: collection.relativePath,
    });
    collectedPages.set(collection.key, page);
  }

  // The built-in 我的笔记 is a first-class personal note, created through the
  // same lifecycle as user-created notes; it is not a managed folder file and
  // does not participate in knowledge themes or links.
  for (const definition of INITIAL_WORKBENCH_NOTES) {
    await ensureInitialNote(input.personalKnowledgeFeature, definition);
  }

  const snapshot = await input.personalKnowledgeFeature.queries.snapshot();
  const existingThemeIds = new Set(snapshot.themes.map((theme) => theme.id));
  for (const theme of INITIAL_KNOWLEDGE_THEMES) {
    if (existingThemeIds.has(theme.id)) continue;
    await input.personalKnowledgeFeature.commands.execute({ type: "theme.create", theme });
    existingThemeIds.add(theme.id);
  }

  const assignmentKey = (refId: string, themeId: string): string => `${refId}\u0000${themeId}`;
  const existingAssignments = new Set(
    snapshot.assignments.map((assignment) => assignmentKey(assignment.refId, assignment.themeId)),
  );
  for (const assignment of INITIAL_KNOWLEDGE_ASSIGNMENTS) {
    const refId = requiredCollectedPageId(collectedPages, assignment.collectionKey);
    const key = assignmentKey(refId, assignment.themeId);
    if (existingAssignments.has(key)) continue;
    await input.personalKnowledgeFeature.commands.execute({
      type: "theme.assign",
      assignment: { refId, themeId: assignment.themeId, by: "agent", locked: false },
    });
    existingAssignments.add(key);
  }

  const linkKey = (from: string, to: string): string => `${from}\u0000${to}`;
  const existingLinks = new Set(snapshot.links.map((link) => linkKey(link.from, link.to)));
  for (const link of INITIAL_KNOWLEDGE_LINKS) {
    const from = requiredCollectedPageId(collectedPages, link.fromCollectionKey);
    const to = requiredCollectedPageId(collectedPages, link.toCollectionKey);
    const key = linkKey(from, to);
    if (existingLinks.has(key)) continue;
    await input.personalKnowledgeFeature.commands.execute({ type: "knowledge.link_add", link: { from, to } });
    existingLinks.add(key);
  }

  input.database.recordInitialization(INITIAL_BUILTIN_DATA_KEY);
}

async function ensureInitialContentEligibility(input: {
  readonly database: SqliteRuntimeDatabase;
  readonly spaceFeature: SpaceFeature;
  readonly personalKnowledgeFeature: PersonalKnowledgeFeature<DocumentPreview>;
  readonly managedAssets: ManagedAssetRepository;
}): Promise<boolean> {
  if (input.database.hasInitialization(INITIAL_BUILTIN_DATA_ELIGIBILITY_KEY)) return true;
  if (input.database.hasInitialization(INITIAL_WORKBENCH_DATA_KEY) || hasCompletedInitialContent(input.database)) {
    return false;
  }

  const [spaces, assets, knowledge] = await Promise.all([
    input.spaceFeature.queries.list(),
    input.managedAssets.list(),
    input.personalKnowledgeFeature.queries.snapshot(),
  ]);
  const hasKnowledge = knowledge.notes.length > 0
    || knowledge.pages.length > 0
    || knowledge.links.length > 0
    || knowledge.themes.length > 0
    || knowledge.assignments.length > 0
    || Object.keys(knowledge.recentlyOpened).length > 0;
  const onlyEmptyDefaultSpace = spaces.length === 0 || (
    spaces.length === 1 &&
    spaces[0]?.id === DEFAULT_SPACE_ID &&
    (await input.spaceFeature.queries.getTree(DEFAULT_SPACE_ID))?.entries.length === 0
  );
  if (!onlyEmptyDefaultSpace || assets.length > 0 || hasKnowledge) return false;

  // Record the first-install cohort before creating a Space or file. A failed
  // attempt must resume instead of being reclassified as an upgraded store.
  input.database.recordInitialization(INITIAL_BUILTIN_DATA_ELIGIBILITY_KEY);
  return true;
}

function hasCompletedInitialContent(database: SqliteRuntimeDatabase): boolean {
  return database.hasInitialization(INITIAL_BUILTIN_DATA_KEY);
}

async function ensureSpace(feature: SpaceFeature, id: string, title: string): Promise<void> {
  const existing = (await feature.queries.list()).find((space) => space.id === id);
  if (existing === undefined) await feature.commands.createSpace({ id, title });
}

async function ensureSpaceManagedRoot(root: string, spaceId: string): Promise<void> {
  await fs.mkdir(path.join(root, spaceId, "files"), { recursive: true });
}

async function ensureInitialNote(
  feature: PersonalKnowledgeFeature<DocumentPreview>,
  definition: InitialWorkbenchNoteDefinition,
): Promise<void> {
  const snapshot = await feature.queries.snapshot();
  if (snapshot.notes.some((note) => note.id === definition.id)) return;
  await feature.commands.createNote({
    id: definition.id,
    spaceId: definition.spaceId,
    title: definition.title,
    bodyMarkdown: definition.bodyMarkdown,
    actor: { kind: "system" },
  });
}

async function ensureInitialManagedFolder(
  input: {
    readonly spaceFeature: SpaceFeature;
    readonly managedSpaceFolderRoot: string;
  },
  definition: InitialWorkbenchManagedFolderDefinition,
): Promise<void> {
  const tree = await input.spaceFeature.queries.getTree(definition.spaceId);
  const existing = tree?.entries.find((entry) => entry.item.id === definition.id)?.item;
  const item = existing ?? await createInitialManagedFolderReference(input, definition);
  if (item.reference.kind !== "managed_folder") {
    throw new Error(`Initial Space reference ${definition.id} is not a managed folder.`);
  }

  await fs.mkdir(item.reference.path, { recursive: true });
  for (const file of definition.files) {
    await materializeInitialFile(item.reference.path, file);
  }
  for (const [relativePath, text] of Object.entries(definition.imageCaptions ?? {})) {
    const current = await input.spaceFeature.queries.getReference(definition.id);
    if (current?.imageCaptions?.[relativePath] !== undefined) continue;
    await input.spaceFeature.commands.updateReferenceImageCaption({
      itemId: definition.id,
      relativePath,
      expectedRevision: 0,
      text,
      actor: { kind: "agent" },
    });
  }
}

async function createInitialManagedFolderReference(
  input: {
    readonly spaceFeature: SpaceFeature;
    readonly managedSpaceFolderRoot: string;
  },
  definition: InitialWorkbenchManagedFolderDefinition,
): Promise<SpaceReferenceItem> {
  const folder = await createManagedSpaceFolder(input.managedSpaceFolderRoot);
  try {
    return await input.spaceFeature.commands.addReference({
      id: definition.id,
      spaceId: definition.spaceId,
      title: definition.title,
      reference: { kind: "managed_folder", path: folder },
      actor: INITIAL_SPACE_ACTOR,
    });
  } catch (error) {
    await deleteManagedSpaceFolder(input.managedSpaceFolderRoot, folder).catch(() => undefined);
    throw error;
  }
}

async function materializeInitialFile(root: string, definition: InitialWorkbenchFileDefinition): Promise<void> {
  const destination = initialFileDestination(root, definition.relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    if (definition.source === "text") {
      await fs.writeFile(destination, definition.content, { encoding: "utf8", flag: "wx" });
    } else {
      const content = await fs.readFile(path.join(INITIAL_ASSET_ROOT, definition.assetFileName));
      await fs.writeFile(destination, content, { flag: "wx" });
    }
  } catch (error) {
    if (isAlreadyExists(error)) {
      if ((await fs.stat(destination)).isFile()) return;
      throw new Error(`Initial Workbench file target is not a regular file: ${definition.relativePath}`);
    }
    throw error;
  }
}

function initialFileDestination(root: string, relativePath: string): string {
  const destination = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(path.resolve(root), destination);
  if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Initial Workbench file path is invalid: ${relativePath}`);
  }
  return destination;
}

async function ensureInitialWebReference(
  feature: SpaceFeature,
  definition: typeof INITIAL_WORKBENCH_WEB_REFERENCES[number],
): Promise<void> {
  const existing = await feature.queries.getReference(definition.id);
  if (existing !== undefined) {
    if (existing.reference.kind !== "web_page" || existing.reference.url !== definition.url) {
      throw new Error(`Initial Space reference ${definition.id} does not match its web source.`);
    }
    if (existing.annotation === undefined && definition.annotation !== undefined) {
      await feature.commands.updateReferenceAnnotation({
        itemId: existing.id,
        expectedRevision: 0,
        patch: definition.annotation,
        actor: { kind: "agent" },
      });
    }
    return;
  }
  await feature.commands.addReference({
    id: definition.id,
    spaceId: definition.spaceId,
    title: definition.title,
    reference: { kind: "web_page", url: definition.url },
    ...(definition.annotation === undefined ? {} : { annotation: definition.annotation }),
    actor: INITIAL_SPACE_ACTOR,
  });
}

function requiredCollectedPageId(
  pages: ReadonlyMap<InitialKnowledgeCollectionKey, KnowledgePage>,
  key: InitialKnowledgeCollectionKey,
): string {
  const page = pages.get(key);
  if (page === undefined) throw new Error(`Initial Knowledge collection ${key} was not created.`);
  return page.refId;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
