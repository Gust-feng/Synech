import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FileSystemSkillStateStore,
  resolveSkillStateStorePath,
  type SkillRootInput,
  type SkillStateStore,
} from "../../skills/index.js";
import type { SubAgentRootInput } from "../../sub-agents/sub-agent-loader.js";

export type RuntimeAssetRootOptions = {
  readonly skillRoots?: readonly SkillRootInput[];
  readonly additionalSkillRoots?: readonly SkillRootInput[];
  readonly subAgentRoots?: readonly SubAgentRootInput[];
  readonly additionalSubAgentRoots?: readonly SubAgentRootInput[];
};

export function resolveSkillRoots(
  options: RuntimeAssetRootOptions,
  input: { readonly executionRoot?: string } = {},
): readonly SkillRootInput[] {
  return options.skillRoots ?? [
    ...resolveDefaultSkillRoots({ executionRoot: input.executionRoot }),
    ...(options.additionalSkillRoots ?? []),
  ];
}

export function resolveSubAgentRoots(
  options: RuntimeAssetRootOptions,
  input: { readonly executionRoot?: string } = {},
): readonly SubAgentRootInput[] {
  return options.subAgentRoots ?? [
    ...resolveDefaultSubAgentRoots({ executionRoot: input.executionRoot }),
    ...(options.additionalSubAgentRoots ?? []),
  ];
}

export function resolveDefaultSkillRoots(input: {
  readonly cwd?: string;
  readonly home?: string;
  readonly executionRoot?: string;
} = {}): readonly SkillRootInput[] {
  const projectBase = input.executionRoot ?? input.cwd ?? process.cwd();
  const projectRoot = path.join(projectBase, ".agents", "skills");
  const userRoot = path.join(input.home ?? homeDirectory(), ".agents", "skills");
  if (path.resolve(projectRoot) === path.resolve(userRoot)) {
    return [{ rootPath: projectRoot, sourceKind: "project", sourceRootId: "project", precedence: 100 }];
  }
  return [
    { rootPath: userRoot, sourceKind: "user", sourceRootId: "user", precedence: 10 },
    { rootPath: projectRoot, sourceKind: "project", sourceRootId: "project", precedence: 100 },
  ];
}

export function resolveDefaultSubAgentRoots(input: {
  readonly cwd?: string;
  readonly home?: string;
  readonly builtinRoot?: string;
  readonly executionRoot?: string;
} = {}): readonly SubAgentRootInput[] {
  const builtinRoot = input.builtinRoot ?? path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "sub-agents",
    "builtin",
  );
  const projectBase = input.executionRoot ?? input.cwd ?? process.cwd();
  const projectRoot = path.join(projectBase, ".agents", "sub-agents");
  const userRoot = path.join(input.home ?? homeDirectory(), ".agents", "sub-agents");
  const roots: SubAgentRootInput[] = [
    { rootPath: builtinRoot, sourceKind: "builtin", sourceRootId: "builtin", precedence: 1 },
  ];
  if (path.resolve(projectRoot) !== path.resolve(userRoot)) {
    roots.push({ rootPath: userRoot, sourceKind: "user", sourceRootId: "user", precedence: 10 });
  }
  roots.push({ rootPath: projectRoot, sourceKind: "project", sourceRootId: "project", precedence: 100 });
  return roots;
}

export function createSkillStateStore(configDirectory: string): SkillStateStore {
  return new FileSystemSkillStateStore(resolveSkillStateStorePath(configDirectory));
}

function homeDirectory(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
}
