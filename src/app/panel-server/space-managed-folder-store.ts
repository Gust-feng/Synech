import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { isWithinRoot } from "../local-filesystem/index.js";

/** Host-owned storage for directories created from a Space, separate from user-linked workspaces. */
export async function createManagedSpaceFolder(root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  const folder = path.join(root, randomUUID());
  await fs.mkdir(folder);
  return folder;
}

export async function deleteManagedSpaceFolder(root: string, folder: string): Promise<void> {
  const rootPath = path.resolve(root);
  const folderPath = path.resolve(folder);
  if (path.relative(rootPath, folderPath).length === 0 || !isWithinRoot(rootPath, folderPath)) {
    throw new Error("Managed Space folder is outside its storage root.");
  }
  await fs.rm(folderPath, { recursive: true, force: false });
}