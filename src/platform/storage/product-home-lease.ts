import { createHash, randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { renameWithRetry } from "../../kernel/fs/atomic-write.js";

export const PRODUCT_HOME_LEASE_FILENAME = ".synech-product-home-owner.json";
export const PRODUCT_HOME_LEASE_RECOVERY_DIRECTORY = ".synech-product-home-lease-recovery";
const INCOMPLETE_LEASE_STALE_AFTER_MS = 30_000;
const RELEASE_MAX_ATTEMPTS = 4;

type ProductHomeOwner = {
  readonly version: 1;
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
};

type LeaseSnapshot = {
  readonly owner?: ProductHomeOwner;
  readonly fingerprint: string;
  readonly modifiedAtMs: number;
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

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fs.writeFile(leasePath, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
      return createLease(productHome, leasePath, owner);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }

    const existing = await readLeaseSnapshot(leasePath);
    if (existing === undefined) continue;
    if (existing.owner !== undefined && processIsAlive(existing.owner.pid)) {
      throw new ProductHomeInUseError(productHome, existing.owner.pid);
    }
    if (existing.owner === undefined && Date.now() - existing.modifiedAtMs < INCOMPLETE_LEASE_STALE_AFTER_MS) {
      throw new ProductHomeInUseError(productHome);
    }
    await claimStaleLease(productHome, leasePath, existing);
  }
  throw new ProductHomeInUseError(productHome);
}

function createLease(
  productHome: string,
  leasePath: string,
  owner: ProductHomeOwner,
): ProductHomeLease {
  let released = false;
  return {
    productHome,
    async release() {
      if (released) return;
      const current = await readLeaseSnapshot(leasePath);
      if (current?.owner?.instanceId !== owner.instanceId) {
        released = true;
        return;
      }
      const removed = await unlinkOwnedLeaseWithRetry(leasePath, owner.instanceId);
      if (removed) released = true;
    },
  };
}

/**
 * Serializes takeover for one observed lease generation without deleting a fixed
 * path blindly. The identity-specific gate is intentionally retained: a paused
 * contender that observed the old generation can never move a newer owner.
 */
async function claimStaleLease(
  productHome: string,
  leasePath: string,
  existing: LeaseSnapshot,
): Promise<void> {
  const recoveryRoot = path.join(productHome, PRODUCT_HOME_LEASE_RECOVERY_DIRECTORY);
  await fs.mkdir(recoveryRoot, { recursive: true });
  const recoveryDirectory = path.join(recoveryRoot, existing.fingerprint);
  try {
    await fs.mkdir(recoveryDirectory);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return;
    throw error;
  }

  try {
    await renameWithRetry(leasePath, path.join(recoveryDirectory, "owner.json"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    await fs.rmdir(recoveryDirectory).catch(() => undefined);
    throw error;
  }
}

async function readLeaseSnapshot(leasePath: string): Promise<LeaseSnapshot | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(leasePath, "r");
    const [source, stat] = await Promise.all([handle.readFile("utf8"), handle.stat()]);
    const owner = parseOwner(source);
    return {
      owner,
      fingerprint: leaseFingerprint(source, stat, owner?.instanceId),
      modifiedAtMs: stat.mtimeMs,
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseOwner(source: string): ProductHomeOwner | undefined {
  try {
    const value = JSON.parse(source) as unknown;
    if (typeof value !== "object" || value === null) return undefined;
    const owner = value as Partial<ProductHomeOwner>;
    return owner.version === 1 && typeof owner.instanceId === "string" &&
      Number.isSafeInteger(owner.pid) && (owner.pid ?? 0) > 0 &&
      typeof owner.startedAt === "string"
      ? owner as ProductHomeOwner
      : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function leaseFingerprint(source: string, stat: Stats, instanceId: string | undefined): string {
  return createHash("sha256")
    .update(instanceId === undefined
      ? `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}:${stat.size}\n`
      : `owner:${instanceId}\n`)
    .update(source)
    .digest("hex");
}

async function unlinkOwnedLeaseWithRetry(leasePath: string, instanceId: string): Promise<boolean> {
  for (let attempt = 1; attempt <= RELEASE_MAX_ATTEMPTS; attempt += 1) {
    const current = await readLeaseSnapshot(leasePath);
    if (current?.owner?.instanceId !== instanceId) return true;
    try {
      await fs.unlink(leasePath);
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return true;
      if (attempt >= RELEASE_MAX_ATTEMPTS || !isTransientReleaseError(error)) throw error;
      await delay(10 * attempt);
    }
  }
  return false;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

function isTransientReleaseError(error: unknown): boolean {
  return isNodeError(error, "EPERM") || isNodeError(error, "EACCES") || isNodeError(error, "EBUSY");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
