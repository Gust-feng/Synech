import { promises as fs } from "node:fs";

import { productStorageDirectories, type ProductPaths } from "./product-paths.js";

/** Creates the directories owned by Synech. Safe to call on every startup. */
export async function initializeProductStorage(paths: ProductPaths): Promise<void> {
  await Promise.all(
    productStorageDirectories(paths).map((directory) => fs.mkdir(directory, { recursive: true })),
  );
}
