import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const LEASE_FILENAME = ".panel-runtime-owner.json";
const INCOMPLETE_LEASE_STALE_AFTER_MS = 30_000;

type RuntimeDirectoryOwner = {
  readonly version: 1;
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
};

export class PanelHostDirectoryInUseError extends Error {
  readonly code = "panel_runtime_directory_in_use" as const;

  constructor(
    readonly runtimeDirectory: string,
    readonly ownerPid?: number,
  ) {
    super(ownerPid === undefined
      ? `Panel runtime directory ${runtimeDirectory} is already owned by another instance.`
      : `Panel runtime directory ${runtimeDirectory} is already owned by process ${ownerPid}.`);
    this.name = "PanelHostDirectoryInUseError";
  }
}

export type PanelHostDirectoryLease = {
  readonly runtimeDirectory: string;
  release(): Promise<void>;
};

export async function acquirePanelHostDirectoryLease(
  runtimeDirectory: string,
): Promise<PanelHostDirectoryLease> {
  await fs.mkdir(runtimeDirectory, { recursive: true });
  const leasePath = path.join(runtimeDirectory, LEASE_FILENAME);
  const owner: RuntimeDirectoryOwner = {
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
        runtimeDirectory,
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
        throw new PanelHostDirectoryInUseError(runtimeDirectory, existing.pid);
      }
      if (existing === undefined && await leaseIsRecent(leasePath)) {
      throw new PanelHostDirectoryInUseError(runtimeDirectory);
      }
      await fs.unlink(leasePath).catch((unlinkError: unknown) => {
        if (!isFileMissing(unlinkError)) throw unlinkError;
      });
    }
  }
  throw new PanelHostDirectoryInUseError(runtimeDirectory);
}

async function readOwner(leasePath: string): Promise<RuntimeDirectoryOwner | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(leasePath, "utf8")) as unknown;
    if (typeof value !== "object" || value === null) return undefined;
    const owner = value as Partial<RuntimeDirectoryOwner>;
    return owner.version === 1 && typeof owner.instanceId === "string" &&
      Number.isSafeInteger(owner.pid) && (owner.pid ?? 0) > 0 &&
      typeof owner.startedAt === "string"
      ? owner as RuntimeDirectoryOwner
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
