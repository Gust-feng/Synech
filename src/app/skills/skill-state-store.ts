import { promises as fs } from "node:fs";
import path from "node:path";
import { isFileNotFound } from "../../kernel/values/index.js";
import { z } from "zod";
import type { SkillDefinition } from "./contracts.js";
import { nowIso } from "../../kernel/id.js";

export type SkillStateRecord = {
  readonly skillId: string;
  readonly stateKey?: string;
  readonly sourceKind?: SkillDefinition["sourceKind"];
  readonly sourceRootId?: string;
  readonly sourcePrecedence?: number;
  readonly enabled?: boolean;
  readonly lastUsedAt?: string;
};

export type SkillStateTarget = {
  readonly skillId: string;
  readonly stateKey?: string;
  readonly sourceKind?: SkillDefinition["sourceKind"];
  readonly sourceRootId?: string;
  readonly sourcePrecedence?: number;
};

export interface SkillStateStore {
  readStates(): Promise<ReadonlyMap<string, SkillStateRecord>>;
  setEnabled(stateKey: string, enabled: boolean, target?: SkillStateTarget): Promise<SkillStateRecord>;
  markUsed(stateKey: string, usedAt?: string, target?: SkillStateTarget): Promise<SkillStateRecord>;
}

export class FileSystemSkillStateStore implements SkillStateStore {
  constructor(private readonly filePath: string) {}

  async readStates(): Promise<ReadonlyMap<string, SkillStateRecord>> {
    const raw = await fs.readFile(this.filePath, "utf8").catch((error: unknown) => {
      if (isFileNotFound(error)) {
        return undefined;
      }
      throw error;
    });
    if (raw === undefined || raw.trim().length === 0) {
      return new Map();
    }
    const parsed = parseSkillStateFile(raw);
    return parsed === undefined
      ? new Map()
      : new Map(parsed.skills.map((record) => [record.stateKey, record] as const));
  }

  private async writeStates(states: ReadonlyMap<string, SkillStateRecord>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const skills = [...states.values()].sort((left, right) =>
      requiredStateKey(left).localeCompare(requiredStateKey(right))
    );
    await fs.writeFile(this.filePath, `${JSON.stringify({ version: 1, skills }, null, 2)}\n`, "utf8");
  }

  async setEnabled(stateKey: string, enabled: boolean, target?: SkillStateTarget): Promise<SkillStateRecord> {
    const states = new Map(await this.readStates());
    const previous = states.get(stateKey);
    const next: SkillStateRecord = {
      skillId: target?.skillId ?? previous?.skillId ?? stateKey,
      stateKey,
      sourceKind: target?.sourceKind ?? previous?.sourceKind,
      sourceRootId: target?.sourceRootId ?? previous?.sourceRootId,
      sourcePrecedence: target?.sourcePrecedence ?? previous?.sourcePrecedence,
      enabled,
      lastUsedAt: previous?.lastUsedAt,
    };
    states.set(stateKey, next);
    await this.writeStates(states);
    return next;
  }

  async markUsed(stateKey: string, usedAt = nowIso(), target?: SkillStateTarget): Promise<SkillStateRecord> {
    const states = new Map(await this.readStates());
    const previous = states.get(stateKey);
    const next: SkillStateRecord = {
      skillId: target?.skillId ?? previous?.skillId ?? stateKey,
      stateKey,
      sourceKind: target?.sourceKind ?? previous?.sourceKind,
      sourceRootId: target?.sourceRootId ?? previous?.sourceRootId,
      sourcePrecedence: target?.sourcePrecedence ?? previous?.sourcePrecedence,
      enabled: previous?.enabled,
      lastUsedAt: usedAt,
    };
    states.set(stateKey, next);
    await this.writeStates(states);
    return next;
  }
}

export function resolveSkillStateStorePath(configDirectory: string): string {
  return path.join(configDirectory, "skills-state.json");
}

export function skillStateKeyForSkill(skill: Pick<SkillDefinition, "id" | "sourceRootId"> & {
  readonly stateKey?: string;
}): string {
  if (typeof skill.stateKey === "string" && skill.stateKey.trim().length > 0) {
    return skill.stateKey.trim();
  }
  return skillStateKeyForFacts({
    skillId: skill.id,
    sourceRootId: skill.sourceRootId,
  });
}

export function skillStateTargetForSkill(skill: Pick<SkillDefinition, "id" | "sourceKind" | "sourceRootId" | "sourcePrecedence"> & {
  readonly stateKey?: string;
}): SkillStateTarget {
  return {
    skillId: skill.id,
    stateKey: skillStateKeyForSkill(skill),
    sourceKind: skill.sourceKind,
    sourceRootId: skill.sourceRootId,
    sourcePrecedence: skill.sourcePrecedence,
  };
}

export function skillStateKeyForFacts(input: {
  readonly skillId: string;
  readonly sourceRootId?: string;
}): string {
  const root = safeStateKeySegment(input.sourceRootId ?? "unscoped");
  const skill = safeStateKeySegment(input.skillId);
  return `source:${root}:${skill}`;
}

type SourceQualifiedSkillStateRecord = SkillStateRecord & { readonly stateKey: string };

function parseSkillStateFile(raw: string): { readonly skills: readonly SourceQualifiedSkillStateRecord[] } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  const parsed = SKILL_STATE_FILE_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function safeStateKeySegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function requiredStateKey(record: SkillStateRecord): string {
  if (record.stateKey === undefined || record.stateKey.length === 0) {
    throw new Error("Skill state writes require a source-qualified stateKey.");
  }
  return record.stateKey;
}

const SKILL_STATE_FILE_SCHEMA = z.object({
  version: z.literal(1),
  skills: z.array(z.object({
    skillId: z.string().min(1),
    stateKey: z.string().min(1),
    sourceKind: z.enum(["project", "user", "plugin", "admin", "custom"]).optional(),
    sourceRootId: z.string().min(1).optional(),
    sourcePrecedence: z.number().int().optional(),
    enabled: z.boolean().optional(),
    lastUsedAt: z.string().min(1).optional(),
  }).strict()),
}).strict();
