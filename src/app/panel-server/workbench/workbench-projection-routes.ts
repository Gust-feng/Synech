import type { IncomingMessage, ServerResponse } from "node:http";

import type { WorkbenchProjectionChange } from "../../panel-api/workbench.js";
import { SseResponseWriter } from "../sse-response-writer.js";

const PROJECTION_STREAM_PATH = "/api/projection-changes";
const PROJECTION_STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

export type WorkbenchProjectionRouteDependencies = {
  readonly projectionChanges: {
    subscribe(listener: (change: WorkbenchProjectionChange) => void): () => void;
    replay(cursor?: number): { readonly changes: readonly WorkbenchProjectionChange[]; readonly cursor: number };
  };
};

export async function handleWorkbenchProjectionRoute(
  dependencies: WorkbenchProjectionRouteDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (request.method !== "GET" || url.pathname !== PROJECTION_STREAM_PATH) return false;

  let initialized = false;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const buffered: WorkbenchProjectionChange[] = [];
  const writer = new SseResponseWriter(response, { onFailure: () => cleanup() });
  const unsubscribe = dependencies.projectionChanges.subscribe((change) => {
    if (!initialized) buffered.push(change);
    else if (!writer.enqueue(frame(change))) cleanup();
  });
  request.once("close", cleanup);
  request.once("error", cleanup);
  response.once("close", cleanup);
  response.once("error", cleanup);

  try {
    const replay = dependencies.projectionChanges.replay(requestCursor(request, url));
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    if (!(await writer.write(": workbench projection changes\n\n"))) {
      cleanup();
      return true;
    }
    for (const change of replay.changes) {
      if (!(await writer.write(frame(change)))) {
        cleanup();
        return true;
      }
    }
    while (buffered.length > 0) {
      for (const change of buffered.splice(0)) {
        if (change.revision <= replay.cursor) continue;
        if (!(await writer.write(frame(change)))) {
          cleanup();
          return true;
        }
      }
    }
    initialized = true;
    heartbeat = setInterval(() => {
      if (!writer.enqueue("event: workbench.projection.heartbeat\ndata: {}\n\n")) cleanup();
    }, PROJECTION_STREAM_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    return true;
  } catch (error) {
    cleanup(response.headersSent);
    throw error;
  }

  function cleanup(endResponse = true): void {
    if (closed) return;
    closed = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    writer.close();
    unsubscribe();
    request.off("close", cleanup);
    request.off("error", cleanup);
    response.off("close", cleanup);
    response.off("error", cleanup);
    if (endResponse && !response.writableEnded) response.end();
  }
}

function requestCursor(request: IncomingMessage, url: URL): number | undefined {
  const header = request.headers["last-event-id"];
  const raw = url.searchParams.get("cursor") ?? (Array.isArray(header) ? header[0] : header);
  if (raw === undefined || raw.length === 0) return undefined;
  const cursor = Number(raw);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined;
}

function frame(change: WorkbenchProjectionChange): string {
  return `id: ${change.revision}\nevent: workbench.projection.changed\ndata: ${JSON.stringify(change)}\n\n`;
}
