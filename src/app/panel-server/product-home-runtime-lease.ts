import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";

export type ProductHomeRuntimeLeaseHolder = {
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly executablePath: string;
  readonly productHome: string;
};

export type ProductHomeRuntimeLease = {
  readonly holder: ProductHomeRuntimeLeaseHolder;
  readonly endpoint: string;
  release(): Promise<void>;
};

export type ProductHomeRuntimeLeaseInspection =
  | { readonly status: "available" }
  | { readonly status: "held"; readonly holder: ProductHomeRuntimeLeaseHolder };

export class ProductHomeRuntimeLeaseProbeError extends Error {
  readonly code = "product_home_lease_check_failed" as const;

  constructor(readonly productHome: string, options?: ErrorOptions) {
    super(`Could not verify whether the Synech Product Home is in use: ${productHome}`, options);
    this.name = "ProductHomeRuntimeLeaseProbeError";
  }
}

export class ProductHomeInUseError extends Error {
  readonly code = "product_home_in_use" as const;

  constructor(
    readonly productHome: string,
    readonly holder?: ProductHomeRuntimeLeaseHolder,
  ) {
    super(holder === undefined
      ? `Synech Product Home is already in use: ${productHome}`
      : `Synech Product Home is already in use by process ${holder.pid}: ${productHome}`);
    this.name = "ProductHomeInUseError";
  }
}

/**
 * Holds one OS-owned local IPC endpoint for the lifetime of a PanelHost.
 * Named pipes disappear automatically when a Windows process exits, so crash
 * recovery does not depend on PID liveness or a stale lock file.
 */
export async function acquireProductHomeRuntimeLease(
  productHome: string,
): Promise<ProductHomeRuntimeLease> {
  const resolvedHome = path.resolve(productHome);
  const endpoint = runtimeLeaseEndpoint(resolvedHome);
  const holder: ProductHomeRuntimeLeaseHolder = {
    instanceId: randomUUID(),
    pid: process.pid,
    startedAt: new Date(Date.now() - Math.round(process.uptime() * 1_000)).toISOString(),
    executablePath: process.execPath,
    productHome: resolvedHome,
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const server = createLeaseServer(holder);
    try {
      await listen(server, endpoint);
      return runtimeLease(server, endpoint, holder);
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
      let inspection: ProductHomeRuntimeLeaseInspection;
      try {
        inspection = await inspectProductHomeRuntimeLease(resolvedHome);
      } catch (probeError) {
        if (probeError instanceof ProductHomeRuntimeLeaseProbeError) {
          // The endpoint is occupied but its holder cannot be proven. Treat it
          // as in use so callers can never delete through an unverifiable lease.
          throw new ProductHomeInUseError(resolvedHome);
        }
        throw probeError;
      }
      if (inspection.status === "held" || process.platform === "win32" || attempt > 0) {
        throw new ProductHomeInUseError(
          resolvedHome,
          inspection.status === "held" ? inspection.holder : undefined,
        );
      }
      // Unix socket paths may survive an unclean process exit. A refused
      // endpoint has no live owner, so remove only this exact hashed socket and retry once.
      await rm(endpoint, { force: true });
    }
  }
  throw new ProductHomeInUseError(resolvedHome);
}

/**
 * Checks the same OS-owned endpoint held by PanelHost. A probe failure is not
 * treated as availability: callers that might delete Product Home data must
 * fail closed unless the endpoint is definitely absent or returns a valid
 * holder response.
 */
export function inspectProductHomeRuntimeLease(
  productHome: string,
): Promise<ProductHomeRuntimeLeaseInspection> {
  const resolvedHome = path.resolve(productHome);
  return probeLeaseEndpoint(runtimeLeaseEndpoint(resolvedHome), resolvedHome);
}

function runtimeLease(
  server: Server,
  endpoint: string,
  holder: ProductHomeRuntimeLeaseHolder,
): ProductHomeRuntimeLease {
  let released: Promise<void> | undefined;
  return {
    holder,
    endpoint,
    release() {
      released ??= (async () => {
        await close(server);
        if (process.platform !== "win32") await rm(endpoint, { force: true });
      })();
      return released;
    },
  };
}

function createLeaseServer(holder: ProductHomeRuntimeLeaseHolder): Server {
  const payload = `${JSON.stringify(holder)}\n`;
  return createServer((socket) => {
    // A probe may time out and destroy its client socket before the holder
    // payload is flushed. EPIPE is transport cleanup, not a lease failure.
    socket.on("error", () => undefined);
    socket.end(payload);
  });
}

function runtimeLeaseEndpoint(productHome: string): string {
  const identity = process.platform === "win32" ? productHome.toLowerCase() : productHome;
  const hash = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 24);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\synech-panel-${hash}`
    : path.join(os.tmpdir(), `synech-panel-${hash}.sock`);
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

function probeLeaseEndpoint(
  endpoint: string,
  productHome: string,
): Promise<ProductHomeRuntimeLeaseInspection> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let settled = false;
    let value = "";
    const timer = setTimeout(() => finish(new ProductHomeRuntimeLeaseProbeError(productHome)), 1_000);
    const finish = (error?: Error, inspection?: ProductHomeRuntimeLeaseInspection) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(inspection!);
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      value += chunk;
      if (value.length > 8_192) finish(new ProductHomeRuntimeLeaseProbeError(productHome));
    });
    socket.once("end", () => {
      const holder = parseLeaseHolder(value);
      if (holder === undefined) {
        finish(new ProductHomeRuntimeLeaseProbeError(productHome));
        return;
      }
      finish(undefined, { status: "held", holder });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
        finish(undefined, { status: "available" });
        return;
      }
      finish(new ProductHomeRuntimeLeaseProbeError(productHome, { cause: error }));
    });
  });
}

function parseLeaseHolder(value: string): ProductHomeRuntimeLeaseHolder | undefined {
  try {
    const parsed: unknown = JSON.parse(value.trim());
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const holder = parsed as Record<string, unknown>;
    if (typeof holder.instanceId !== "string" ||
        typeof holder.pid !== "number" || !Number.isSafeInteger(holder.pid) || holder.pid < 1 ||
        typeof holder.startedAt !== "string" ||
        typeof holder.executablePath !== "string" ||
        typeof holder.productHome !== "string") return undefined;
    return {
      instanceId: holder.instanceId,
      pid: holder.pid,
      startedAt: holder.startedAt,
      executablePath: holder.executablePath,
      productHome: holder.productHome,
    };
  } catch {
    return undefined;
  }
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}
