import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_LOG_BYTES = 512 * 1024;

export type WebReferenceMetadataDiagnostic = {
  readonly referenceId: string;
  readonly phase: "startup" | "fetch" | "cleanup" | "worker";
  readonly code: string;
  readonly url?: string;
};

export type WebReferenceMetadataDiagnostics = {
  record(diagnostic: WebReferenceMetadataDiagnostic): Promise<void>;
  release(): Promise<void>;
};

export function createWebReferenceMetadataDiagnostics(filePath: string): WebReferenceMetadataDiagnostics {
  let tail = Promise.resolve();

  function record(diagnostic: WebReferenceMetadataDiagnostic): Promise<void> {
    const operation = tail.then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const currentSize = await fs.stat(filePath).then((value) => value.size, (error: unknown) => isNotFound(error) ? 0 : Promise.reject(error));
      if (currentSize >= MAX_LOG_BYTES) {
        await fs.rename(filePath, `${filePath}.previous`).catch((error: unknown) => {
          if (!isNotFound(error)) throw error;
        });
      }
      const entry = {
        at: new Date().toISOString(),
        referenceId: diagnostic.referenceId,
        phase: diagnostic.phase,
        code: diagnostic.code,
        ...(diagnostic.url === undefined ? {} : { url: redactUrl(diagnostic.url) }),
      };
      await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
    });
    tail = operation.catch(() => undefined);
    return operation;
  }

  return { record, release: async () => await tail };
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid-url";
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === "ENOENT";
}
