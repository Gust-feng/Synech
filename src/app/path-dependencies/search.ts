import type {
  PathDependency,
  PathDependencySearchInput,
  PathDependencySearchMatch,
} from "./contracts.js";

/** Deterministic, explainable baseline search; embeddings are deliberately deferred. */
export function searchPathDependencies(
  dependencies: readonly PathDependency[],
  input: PathDependencySearchInput,
): readonly PathDependencySearchMatch[] {
  const terms = tokenize(input.text);
  if (terms.length === 0) return [];
  const matches: PathDependencySearchMatch[] = [];
  for (const dependency of dependencies) {
    const title = dependency.title.toLocaleLowerCase();
    const methodology = dependency.methodology.toLocaleLowerCase();
    const tags = dependency.tags.map((tag) => tag.toLocaleLowerCase());
    const matchedFields = new Set<PathDependencySearchMatch["matchedFields"][number]>();
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) {
        score += 5;
        matchedFields.add("title");
      }
      if (tags.some((tag) => tag.includes(term))) {
        score += 3;
        matchedFields.add("tag");
      }
      if (methodology.includes(term)) {
        score += 1;
        matchedFields.add("methodology");
      }
    }
    if (score === 0) continue;
    matches.push({ dependency, score, matchedFields: [...matchedFields] });
  }
  const limit = input.limit === undefined ? 20 : Math.max(0, Math.floor(input.limit));
  return matches
    .sort((left, right) => right.score - left.score || right.dependency.updatedAt.localeCompare(left.dependency.updatedAt) || left.dependency.id.localeCompare(right.dependency.id))
    .slice(0, limit);
}

function tokenize(value: string): readonly string[] {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized.length === 0) return [];
  const latin = normalized.split(/[^\p{L}\p{N}_-]+/u).filter((token) => token.length > 0);
  const cjk = [...normalized].filter((char) => /\p{Script=Han}/u.test(char));
  const bigrams = cjk.length < 2 ? [] : cjk.slice(0, -1).map((char, index) => `${char}${cjk[index + 1]}`);
  return [...new Set([...latin, ...bigrams])];
}
