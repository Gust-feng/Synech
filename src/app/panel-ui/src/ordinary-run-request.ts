import type { OrdinaryRunCursor } from "./contracts/run";

export function ordinaryRunResourceUrl(
  runId: string,
  resource: "view" | "stream",
  cursor: OrdinaryRunCursor | undefined
): string {
  const base = `/api/ordinary/runs/${encodeURIComponent(runId)}/${resource}`;
  return cursor === undefined ? base : `${base}?cursor=${encodeURIComponent(cursor)}`;
}