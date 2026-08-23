import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

import { renameWithRetry } from "../../kernel/fs/atomic-write.js";
import { isNodeError, toPersistedJsonShape } from "../../kernel/values/index.js";
import { SPACE_TREE_SCHEMA_VERSION, SpaceFeatureError, type SpaceRepository, type SpaceTreeSnapshot } from "./contracts.js";
import { spaceReferenceAnnotationSchema, spaceReferenceImageCaptionsSchema, spaceReferenceSchema } from "./space-validation.js";

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

/**
 * A single snapshot makes a cross-space move one atomic metadata write. The file
 * contains no external resource content and is not a substitute for workspace storage.
 */
export function createFileSystemSpaceRepository(rootDir: string): SpaceRepository {
  const filePath = path.join(rootDir, "space-tree.json");
  return {
    async read(): Promise<SpaceTreeSnapshot> {
      let content: string;
      try {
        content = await fs.readFile(filePath, "utf8");
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return emptySnapshot();
        throw new SpaceFeatureError("space_repository_failure", `Could not read SpaceTree from ${filePath}`, { cause: error });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content) as unknown;
      } catch (error) {
        throw new SpaceFeatureError("space_snapshot_incompatible", `SpaceTree JSON is invalid: ${filePath}`, { cause: error });
      }
      return validateSpaceTreeSnapshot(parsed);
    },
    async write(snapshot: SpaceTreeSnapshot): Promise<void> {
      const validated = validateSpaceTreeSnapshot(snapshot);
      const directory = path.dirname(filePath);
      const tempDirectory = path.join(directory, ".tmp");
      const tempPath = path.join(tempDirectory, `space-tree.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
      try {
        await fs.mkdir(tempDirectory, { recursive: true });
        await fs.writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        try {
          await renameWithRetry(tempPath, filePath);
        } catch (error) {
          await fs.rm(tempPath, { force: true }).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if (error instanceof SpaceFeatureError) throw error;
        throw new SpaceFeatureError("space_repository_failure", `Could not persist SpaceTree to ${filePath}`, { cause: error });
      }
    },
  };
}

function emptySnapshot(): SpaceTreeSnapshot {
  return { schemaVersion: SPACE_TREE_SCHEMA_VERSION, spaces: [], referenceItems: [] };
}
