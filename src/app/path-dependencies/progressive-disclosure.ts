import type {
  PathDependencyDirectoryEntry,
  PathDependencySearchMatch,
} from "./contracts.js";

/**
 * Progressive disclosure budgets are deliberately owned by the path-
 * dependency feature, while the tokenizer is supplied by the Host. This
 * keeps provider-specific tokenizer code out of the feature contract and
 * still lets each run enforce a real model-token budget when one is known.
 */
export const PATH_DEPENDENCY_DIRECTORY_MAX_ENTRIES = 16;
export const PATH_DEPENDENCY_DIRECTORY_MAX_TOKENS = 2_000;
export const PATH_DEPENDENCY_SEARCH_MAX_RESULTS = 8;
export const PATH_DEPENDENCY_SEARCH_MAX_TOKENS = 1_500;
export const PATH_DEPENDENCY_READ_MAX_TOKENS = 8_000;

export type PathDependencyTokenCounter = (text: string) => number;

/**
 * Render only the smallest useful directory cards that fit the run budget.
 * The excerpt is intentionally disposable; id and revision are retained so a
 * model can always make an exact MemoryRead call. No methodology body is
 * silently substituted for a truncated card.
 */
export function renderPathDependencyDirectory(
  entries: readonly PathDependencyDirectoryEntry[],
  countTokens?: PathDependencyTokenCounter,
): string | undefined {
  const selected: PathDependencyDirectoryEntry[] = [];
  for (const entry of entries.slice(0, PATH_DEPENDENCY_DIRECTORY_MAX_ENTRIES)) {
    const candidate = [...selected, entry];
    if (withinBudget(directoryText(candidate), PATH_DEPENDENCY_DIRECTORY_MAX_TOKENS, countTokens)) {
      selected.push(entry);
      continue;
    }
    // A single unusually long title/tag set must not make the whole directory
    // disappear. Keep its identity and revision, but drop only the optional
    // excerpt if that compact card fits.
    if (selected.length === 0) {
      const compact = { ...entry, excerpt: "" } satisfies PathDependencyDirectoryEntry;
      if (withinBudget(directoryText([compact]), PATH_DEPENDENCY_DIRECTORY_MAX_TOKENS, countTokens)) {
        selected.push(compact);
      }
    }
    break;
  }
  return selected.length === 0 ? undefined : directoryText(selected);
}

/** Fit search candidates without replacing a candidate's facts with a summary. */
export function fitPathDependencySearchMatches(
  matches: readonly PathDependencySearchMatch[],
  countTokens?: PathDependencyTokenCounter,
): readonly PathDependencySearchMatch[] {
  const selected: PathDependencySearchMatch[] = [];
  for (const match of matches.slice(0, PATH_DEPENDENCY_SEARCH_MAX_RESULTS)) {
    const candidate = [...selected, match];
    const projected = candidate.map((item) => ({
      id: item.dependency.id,
      kind: "path_dependency" as const,
      title: item.dependency.title,
      owner: item.dependency.owner,
      revision: item.dependency.revision,
      verification: item.dependency.verification.status,
      tags: item.dependency.tags,
      score: item.score,
      matchedFields: item.matchedFields,
      excerpt: item.dependency.methodology.slice(0, 360),
    }));
    if (!withinBudget(JSON.stringify(projected), PATH_DEPENDENCY_SEARCH_MAX_TOKENS, countTokens)) break;
    selected.push(match);
  }
  return selected;
}

export function exceedsPathDependencyReadBudget(
  value: unknown,
  countTokens?: PathDependencyTokenCounter,
): boolean {
  return !withinBudget(JSON.stringify(value), PATH_DEPENDENCY_READ_MAX_TOKENS, countTokens);
}

function directoryText(entries: readonly PathDependencyDirectoryEntry[]): string {
  return [
    "These are compact, reusable task-method candidates visible to this run. They are not instructions to apply automatically.",
    "Use MemoryRead with an id and revision when a candidate is relevant; only call MemoryReference after you deliberately use its method.",
    JSON.stringify(entries.map((entry) => ({
      id: entry.id,
      owner: entry.owner,
      title: entry.title,
      revision: entry.revision,
      verification: entry.verification,
      tags: entry.tags,
      excerpt: entry.excerpt,
    })), null, 2),
  ].join("\n");
}

function withinBudget(
  text: string,
  budget: number,
  countTokens?: PathDependencyTokenCounter,
): boolean {
  const tokenCount = countTokens === undefined
    ? Math.ceil(text.length / 4)
    : countTokens(text);
  return Number.isFinite(tokenCount) && tokenCount <= budget;
}
