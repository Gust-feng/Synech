import { promises as fs } from "node:fs";
import path from "node:path";
import type { SpaceFeature } from "../../spaces/index.js";

const DEFAULT_SPACE = { id: "space-default", title: "我的空间" } as const;

export function createDefaultSpaceInitializer(
  initialize: () => Promise<void>,
): { ensure(): Promise<void> } {
  let active: Promise<void> | undefined;
  return {
    ensure() {
      if (active !== undefined) return active;
      const attempt = initialize().catch((error: unknown) => {
        if (active === attempt) active = undefined;
        throw error;
      });
      active = attempt;
      return attempt;
    },
  };
}

export async function ensureDefaultSpace(input: {
  readonly spaceFeature: SpaceFeature;
  readonly managedSpaceRoot: string;
}): Promise<void> {
  const spaces = await input.spaceFeature.queries.list();
  if (spaces.length === 0) {
    await input.spaceFeature.commands.createSpace(DEFAULT_SPACE);
  } else if (!spaces.some((space) => space.id === DEFAULT_SPACE.id)) {
    return;
  }
  await fs.mkdir(path.join(input.managedSpaceRoot, DEFAULT_SPACE.id, "files"), { recursive: true });
}
