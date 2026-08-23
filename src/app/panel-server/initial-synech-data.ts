import { promises as fs } from "node:fs";
import path from "node:path";
import type { SqliteRuntimeDatabase } from "../../adapters/runtime-storage/index.js";
import type { PersonalKnowledgeFeature } from "../personal-knowledge/index.js";
import type { SpaceFeature } from "../spaces/index.js";
import {
  DEFAULT_SPACE_ID,
  INITIAL_SYNECH_SPACES,
} from "./initial-synech-content.js";

/**
 * A fresh installation receives ordinary Space data, not a parallel demo
 * projection. Built-in files live in the same managed folders created from the
 * Space UI, and Knowledge captures them through the public collection command.
 */
export const INITIAL_SYNECH_DATA_KEY = "synech-initial-space/v1";
export const INITIAL_SPACE_ID = DEFAULT_SPACE_ID;
export const INITIAL_BUILTIN_DATA_ELIGIBILITY_KEY = "synech-initial-content-eligible/v1";
export const INITIAL_BUILTIN_DATA_KEY = "synech-initial-content/v1";
export const INITIAL_WEB_ANNOTATION_BACKFILL_KEY = "synech-initial-web-annotations/v1";

export type InitialSynechDataInitializer = {
  ensure(): Promise<void>;
};

/** Shares one active initialization attempt and permits a later retry after failure. */
export function createInitialSynechDataInitializer(
  initialize: () => Promise<void>,
): InitialSynechDataInitializer {
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

export async function initializeInitialSynechData(input: {
  readonly database: SqliteRuntimeDatabase;
  readonly spaceFeature: SpaceFeature;
  readonly personalKnowledgeFeature: PersonalKnowledgeFeature;
  readonly managedSpaceRoot: string;
  readonly managedSpaceFolderRoot: string;
}): Promise<void> {
  await fs.mkdir(input.managedSpaceRoot, { recursive: true });
  await fs.mkdir(input.managedSpaceFolderRoot, { recursive: true });
  const initialContentEligible = await ensureInitialContentEligibility(input);

  if (!input.database.hasInitialization(INITIAL_SYNECH_DATA_KEY)) {
    await ensureSpace(input.spaceFeature, INITIAL_SPACE_ID, "我的空间");
    await ensureSpaceManagedRoot(input.managedSpaceRoot, INITIAL_SPACE_ID);
    input.database.recordInitialization(INITIAL_SYNECH_DATA_KEY);
  }

  if (!initialContentEligible || hasCompletedInitialContent(input.database)) return;

  for (const space of INITIAL_SYNECH_SPACES) {
    await ensureSpace(input.spaceFeature, space.id, space.title);
    await ensureSpaceManagedRoot(input.managedSpaceRoot, space.id);
  }

  input.database.recordInitialization(INITIAL_BUILTIN_DATA_KEY);
}

async function ensureInitialContentEligibility(input: {
  readonly database: SqliteRuntimeDatabase;
  readonly spaceFeature: SpaceFeature;
  readonly personalKnowledgeFeature: PersonalKnowledgeFeature;
}): Promise<boolean> {
  if (input.database.hasInitialization(INITIAL_BUILTIN_DATA_ELIGIBILITY_KEY)) return true;
  if (
    input.database.hasInitialization(INITIAL_SYNECH_DATA_KEY)
    || hasCompletedInitialContent(input.database)
  ) {
    return false;
  }

  const [spaces, knowledge] = await Promise.all([
    input.spaceFeature.queries.list(),
    input.personalKnowledgeFeature.queries.snapshot(),
  ]);
  const hasKnowledge = knowledge.notes.length > 0
    || knowledge.pages.length > 0
    || knowledge.links.length > 0
    || knowledge.themes.length > 0
    || knowledge.assignments.length > 0
    || Object.keys(knowledge.recentlyOpened).length > 0;
  if (spaces.length > 0 || hasKnowledge) return false;

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
