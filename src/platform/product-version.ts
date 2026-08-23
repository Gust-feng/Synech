import { readFileSync } from "node:fs";

let cachedProductPackageVersion: string | undefined;

export function readProductPackageVersion(): string {
  if (cachedProductPackageVersion !== undefined) {
    return cachedProductPackageVersion;
  }
  try {
    const parsed = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      readonly version?: unknown;
    };
    cachedProductPackageVersion =
      typeof parsed.version === "string" && parsed.version.trim().length > 0
        ? parsed.version.trim()
        : "unknown";
  } catch {
    cachedProductPackageVersion = "unknown";
  }
  return cachedProductPackageVersion;
}
