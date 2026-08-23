import { promises as fs } from "node:fs";

import type { SpaceReferenceItem } from "./contracts.js";

export type SpaceExternalSourceSnapshot = {
  readonly identity: string;
  readonly kind: "file" | "folder" | "other";
};

export type SpaceExternalSourceInspector = (
  sourcePath: string,
) => Promise<SpaceExternalSourceSnapshot | undefined>;

export type SpaceExternalReferenceStatus = "current" | "missing" | "replaced";

export type SpaceExternalSourceExpectation = {
  readonly path: string;
  readonly kind: "file" | "folder";
  readonly sourceIdentity?: string;
};

/** Captures a filesystem object's stable platform identity without exposing it to the model. */
export const inspectSpaceExternalSource: SpaceExternalSourceInspector = async (sourcePath) => {
  const stat = await fs.stat(sourcePath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
  if (stat === undefined) return undefined;
  return {
    identity: `${stat.dev}:${stat.ino}`,
    kind: stat.isFile() ? "file" : stat.isDirectory() ? "folder" : "other",
  };
};

export async function spaceExternalReferenceStatus(
  item: SpaceReferenceItem,
  inspect: SpaceExternalSourceInspector = inspectSpaceExternalSource,
): Promise<SpaceExternalReferenceStatus> {
  if (item.reference.kind !== "local_file" && item.reference.kind !== "workspace_folder") {
    return "current";
  }
  return await spaceExternalSourceStatus({
    path: item.reference.path,
    kind: item.reference.kind === "local_file" ? "file" : "folder",
    sourceIdentity: item.sourceIdentity,
  }, inspect);
}

export async function spaceExternalSourceStatus(
  expected: SpaceExternalSourceExpectation,
  inspect: SpaceExternalSourceInspector = inspectSpaceExternalSource,
): Promise<SpaceExternalReferenceStatus> {
  const current = await inspect(expected.path);
  if (current === undefined || current.kind !== expected.kind) return "missing";
  return expected.sourceIdentity !== undefined && current.identity !== expected.sourceIdentity
    ? "replaced"
    : "current";
}
