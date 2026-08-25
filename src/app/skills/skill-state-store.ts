import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isFileNotFound } from "../../kernel/values/index.js";
import { renameWithRetry } from "../../kernel/fs/atomic-write.js";
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

export class SkillStateStoreError extends Error {
  readonly code = "skill_state_invalid" as const;

  constructor(readonly filePath: string, cause?: unknown) {
    super(`Skill state file ${filePath} is invalid and was left unchanged.`, { cause });
    this.name = "SkillStateStoreError";
  }
}

export class FileSystemSkillStateStore implements SkillStateStore {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async readStates(): Promise<ReadonlyMap<string, SkillStateRecord>> {
    await this.mutationTail;
    return this.readStatesUnlocked();
  }

  private async readStatesUnlocked(): Promise<ReadonlyMap<string, SkillStateRecord>> {
    const raw = await fs.readFile(this.filePath, "utf8").catch((error: unknown) => {
      if (isFileNotFound(error)) {
        return undefined;
      }
      throw error;
    });
    if (raw === undefined) {
      return new Map();
    }
    const parsed = parseSkillStateFile(raw, this.filePath);
    return new Map(parsed.skills.map((record) => [record.stateKey, record] as const));
  }

  private async writeStates(states: ReadonlyMap<string, SkillStateRecord>): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporary = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`);
    const skills = [...states.values()].sort((left, right) =>
      requiredStateKey(left).localeCompare(requiredStateKey(right))
    );
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, skills }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await renameWithRetry(temporary, this.filePath);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async setEnabled(stateKey: string, enabled: boolean, target?: SkillStateTarget): Promise<SkillStateRecord> {
    return this.runMutation(async () => {
      const states = new Map(await this.readStatesUnlocked());
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
    });
  }

  async markUsed(stateKey: string, usedAt = nowIso(), target?: SkillStateTarget): Promise<SkillStateRecord> {
    return this.runMutation(async () => {
      const states = new Map(await this.readStatesUnlocked());
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
    });
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

function parseSkillStateFile(raw: string, filePath: string): { readonly skills: readonly SourceQualifiedSkillStateRecord[] } {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SkillStateStoreError(filePath, error);
  }
  const parsed = SKILL_STATE_FILE_SCHEMA.safeParse(value);
  if (!parsed.success) throw new SkillStateStoreError(filePath, parsed.error);
  return parsed.data;
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
