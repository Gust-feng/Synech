import path from "node:path";

export type WorkspaceFolderSummary = {
  readonly label: string;
  readonly path?: string;
  /** Whether this run inherited its configured workspace or received a user selection. */
  readonly selection: "default" | "explicit";
};

export function workspaceFolderSummaryFromPath(
  workspacePath: string | undefined,
  selection: WorkspaceFolderSummary["selection"] = "explicit",
): WorkspaceFolderSummary | undefined {
  const normalized = workspacePath?.trim();
  if (normalized === undefined || normalized.length === 0) {
    return undefined;
  }
  return {
    // A configured fallback is an execution fact, not a user-named project. Keep
    // its path for the feature contract but do not promote the host folder name
    // into sidebar navigation.
    label: selection === "default" ? "默认工作区" : path.basename(normalized) || normalized,
    path: normalized,
    selection,
  };
}
