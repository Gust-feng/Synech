import { promises as fs } from "node:fs";
import path from "node:path";
import { isFileNotFound } from "../../kernel/values/index.js";
import type { SkillStateStore } from "./skill-state-store.js";
import {
  readSkillDefinition,
  type AgentSkillDefinition,
  type SkillRootDescriptor,
  type SkillSourceKind,
} from "./skill-package-reader.js";

export type SkillDiscoveryOptions = {
  readonly roots: readonly SkillRootInput[];
  readonly stateStore?: SkillStateStore;
};

export type SkillRootInput = string | SkillRootDescriptor;

export async function discoverSkills(options: SkillDiscoveryOptions): Promise<readonly AgentSkillDefinition[]> {
  const roots = normalizeSkillRoots(options.roots);
  const discovered = await Promise.all(roots.map((root) => discoverSkillsUnderRoot(root)));
  const states = await options.stateStore?.readStates();
  const skills = discovered.flat();
  return skills
    .map((skill) => applyPersistedSkillState(
      skill,
      states?.get(skill.stateKey)
    ))
    .sort(compareDiscoveredSkills);
}
async function discoverSkillsUnderRoot(root: SkillRootDescriptor): Promise<readonly AgentSkillDefinition[]> {
  const entries = await fs.readdir(root.rootPath, { withFileTypes: true }).catch((error: unknown) => {
    if (isFileNotFound(error)) {
      return [];
    }
    throw error;
  });
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readSkillDefinition(root, path.join(root.rootPath, entry.name), entry.name))
  );
}

function applyPersistedSkillState(
  skill: AgentSkillDefinition,
  state: { readonly enabled?: boolean; readonly lastUsedAt?: string } | undefined
): AgentSkillDefinition {
  if (state === undefined) {
    return skill;
  }
  return {
    ...skill,
    enabled: skill.loadError === undefined ? state.enabled ?? skill.enabled : false,
    lastUsedAt: state.lastUsedAt ?? skill.lastUsedAt,
  };
}

export function normalizeSkillRoots(roots: readonly SkillRootInput[]): readonly SkillRootDescriptor[] {
  return roots.map((root, index) => normalizeSkillRoot(root, index));
}

function normalizeSkillRoot(root: SkillRootInput, index: number): SkillRootDescriptor {
  if (typeof root === "string") {
    const rootPath = path.resolve(root);
    return {
      rootPath,
      sourceKind: "custom",
      sourceRootId: `custom:${index + 1}`,
      precedence: index,
    };
  }
  return {
    rootPath: path.resolve(root.rootPath),
    sourceKind: root.sourceKind,
    sourceRootId: safeSourceRootId(root.sourceRootId, root.sourceKind, index),
    precedence: Number.isFinite(root.precedence) ? Math.trunc(root.precedence) : index,
  };
}

function safeSourceRootId(value: string, sourceKind: SkillSourceKind, index: number): string {
  const safe = value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : `${sourceKind}:${index + 1}`;
}

function compareDiscoveredSkills(left: AgentSkillDefinition, right: AgentSkillDefinition): number {
  return left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id) ||
    right.sourcePrecedence - left.sourcePrecedence ||
    left.sourceRootId.localeCompare(right.sourceRootId) ||
    left.sourcePath.localeCompare(right.sourcePath);
}
