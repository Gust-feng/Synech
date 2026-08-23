import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const PRODUCT_HOME_LEASE_FILENAME = ".synech-product-home-owner.json";
const INCOMPLETE_LEASE_STALE_AFTER_MS = 30_000;

type ProductHomeOwner = {
  readonly version: 1;
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
};

export class ProductHomeInUseError extends Error {
  readonly code = "product_home_in_use" as const;

  constructor(readonly productHome: string, readonly ownerPid?: number) {
    super(ownerPid === undefined
      ? `Product Home ${productHome} is already owned by another instance.`
      : `Product Home ${productHome} is already owned by process ${ownerPid}.`);
    this.name = "ProductHomeInUseError";
  }
}

export type ProductHomeLease = {
  readonly productHome: string;
  release(): Promise<void>;
};

export async function acquireProductHomeLease(productHome: string): Promise<ProductHomeLease> {
  await fs.mkdir(productHome, { recursive: true });
  const leasePath = path.join(productHome, PRODUCT_HOME_LEASE_FILENAME);
  const owner: ProductHomeOwner = {
    version: 1,
    instanceId: randomUUID(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.writeFile(leasePath, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
      let released = false;
      return {
        productHome,
        async release() {
          if (released) return;
          released = true;
          const current = await readOwner(leasePath);
          if (current?.instanceId !== owner.instanceId) return;
          await fs.unlink(leasePath).catch((error: unknown) => {
            if (!isFileMissing(error)) throw error;
          });
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await readOwner(leasePath);
      if (existing !== undefined && processIsAlive(existing.pid)) {
        throw new ProductHomeInUseError(productHome, existing.pid);
      }
      if (existing === undefined && await leaseIsRecent(leasePath)) {
        throw new ProductHomeInUseError(productHome);
      }
      await fs.unlink(leasePath).catch((unlinkError: unknown) => {
        if (!isFileMissing(unlinkError)) throw unlinkError;
      });
    }
  }
  throw new ProductHomeInUseError(productHome);
}

async function readOwner(leasePath: string): Promise<ProductHomeOwner | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(leasePath, "utf8")) as unknown;
    if (typeof value !== "object" || value === null) return undefined;
    const owner = value as Partial<ProductHomeOwner>;
    return owner.version === 1 && typeof owner.instanceId === "string" &&
      Number.isSafeInteger(owner.pid) && (owner.pid ?? 0) > 0 &&
      typeof owner.startedAt === "string"
      ? owner as ProductHomeOwner
      : undefined;
  } catch (error) {
    if (isFileMissing(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function leaseIsRecent(leasePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(leasePath);
    return Date.now() - stat.mtimeMs < INCOMPLETE_LEASE_STALE_AFTER_MS;
  } catch (error) {
    if (isFileMissing(error)) return false;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isPermissionDenied(error);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isFileMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isPermissionDenied(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EPERM";
}
