import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { renameWithRetry } from "../../kernel/fs/atomic-write.js";
import { PRODUCT_HOME_LEASE_FILENAME } from "./product-home-lease.js";
import { productStorageDirectories, type ProductPaths } from "./product-paths.js";

export const STORAGE_LAYOUT_VERSION = 1 as const;
export const STORAGE_LAYOUT_MANIFEST = {
  product: "synech",
  layoutVersion: STORAGE_LAYOUT_VERSION,
} as const;

export class ProductStorageLayoutError extends Error {
  readonly code = "product_storage_layout_invalid" as const;

  constructor(readonly productHome: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProductStorageLayoutError";
  }
}

/** Initializes or validates Product Home. Caller must already own its root-level lease. */
export async function initializeProductStorage(paths: ProductPaths): Promise<void> {
  await fs.mkdir(paths.productHome, { recursive: true });
  const manifest = await readManifest(paths);
  if (manifest === undefined) {
    const entries = (await fs.readdir(paths.productHome)).filter(
      (entry) => entry !== PRODUCT_HOME_LEASE_FILENAME,
    );
    if (entries.length > 0) {
      throw new ProductStorageLayoutError(
        paths.productHome,
        `Product Home is not empty and has no storage-layout.json: ${paths.productHome}`,
      );
    }
    await writeManifestAtomically(paths);
  } else {
    assertSupportedManifest(paths, manifest);
  }

  try {
    await Promise.all(productStorageDirectories(paths).map((directory) => fs.mkdir(directory, { recursive: true })));
  } catch (error) {
    if (isPathTypeConflict(error)) {
      throw new ProductStorageLayoutError(
        paths.productHome,
        `A required storage directory is occupied by a file below Product Home: ${paths.productHome}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function readManifest(paths: ProductPaths): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(paths.layoutManifest, "utf8")) as unknown;
  } catch (error) {
    if (isFileMissing(error)) return undefined;
    throw new ProductStorageLayoutError(
      paths.productHome,
      `storage-layout.json is unreadable or invalid: ${paths.layoutManifest}`,
      { cause: error },
    );
  }
}

function assertSupportedManifest(paths: ProductPaths, value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidManifest(paths);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 || keys[0] !== "layoutVersion" || keys[1] !== "product" ||
    record.product !== STORAGE_LAYOUT_MANIFEST.product ||
    record.layoutVersion !== STORAGE_LAYOUT_MANIFEST.layoutVersion
  ) {
    throw invalidManifest(paths);
  }
}

function invalidManifest(paths: ProductPaths): ProductStorageLayoutError {
  return new ProductStorageLayoutError(
    paths.productHome,
    `Unsupported storage-layout.json. Expected ${JSON.stringify(STORAGE_LAYOUT_MANIFEST)}.`,
  );
}

async function writeManifestAtomically(paths: ProductPaths): Promise<void> {
  const temporaryPath = path.join(
    paths.productHome,
    `.storage-layout.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(STORAGE_LAYOUT_MANIFEST, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await renameWithRetry(temporaryPath, paths.layoutManifest);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isFileMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isPathTypeConflict(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "EEXIST" || error.code === "ENOTDIR");
}
