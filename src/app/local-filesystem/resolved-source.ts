import path from "node:path";

export type ResolvedSource<Kind extends string = string> = {
  readonly path: string;
  readonly sourceKind: Kind;
  readonly sourceIdentity?: string;
  readonly mountVersion?: string;
};

/** Compares the source facts that protect one filesystem mutation. */
export function sameResolvedSource(left: ResolvedSource, right: ResolvedSource): boolean {
  const leftPath = path.resolve(left.path);
  const rightPath = path.resolve(right.path);
  const samePath = process.platform === "win32"
    ? leftPath.toLocaleLowerCase("en-US") === rightPath.toLocaleLowerCase("en-US")
    : leftPath === rightPath;
  return samePath
    && left.sourceKind === right.sourceKind
    && left.sourceIdentity === right.sourceIdentity
    && left.mountVersion === right.mountVersion;
}
