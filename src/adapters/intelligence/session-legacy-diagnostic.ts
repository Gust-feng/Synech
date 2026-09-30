export type LegacyV3SessionHeader = {
  readonly id: string;
  readonly cwd: string;
  readonly timestamp: string;
};

/** Matches the structural v3 header contract used by Pi 0.87's JSONL codec. */
export function parseLegacyV3SessionHeader(line: string | undefined): LegacyV3SessionHeader | undefined {
  if (line === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const header = value as Record<string, unknown>;
  if (header.type !== "session" || header.version !== 3 ||
      typeof header.id !== "string" || typeof header.cwd !== "string" ||
      typeof header.timestamp !== "string" || !Number.isFinite(Date.parse(header.timestamp)) ||
      (header.parentSession !== undefined && typeof header.parentSession !== "string")) {
    return undefined;
  }
  return { id: header.id, cwd: header.cwd, timestamp: header.timestamp };
}
