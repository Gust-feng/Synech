import path from "node:path";

export type WorkspaceFolderSummary = {
  readonly label: string;
  readonly path?: string;
};

export function workspaceFolderSummaryFromPath(
  workspacePath: string | undefined,
): WorkspaceFolderSummary | undefined {
  const normalized = workspacePath?.trim();
  if (normalized === undefined || normalized.length === 0) {
    return undefined;
  }
  return {
    label: path.basename(normalized) || normalized,
    path: normalized,
  };
}
