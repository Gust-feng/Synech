import type { SkillDefinition, SkillSelectionDecisionFacts } from "./contracts.js";

export type SelectedSkillLoadStatus = "loaded" | "failed";

export type SelectedSkillUsageRecordStatus = "succeeded" | "failed" | "skipped";

/** Skill body and frozen selection facts prepared for one Ordinary run. */
export type SelectedSkillContext = {
  readonly skill: SkillDefinition;
  readonly body: string;
  readonly triggerReason: string;
  readonly selectedAt?: string;
  readonly loadStatus?: SelectedSkillLoadStatus;
  readonly loadedAt?: string;
  readonly bodyHash?: string;
  readonly contentHash?: string;
  readonly bodyCharCount?: number;
  readonly truncated?: boolean;
  readonly omitted?: boolean;
  readonly error?: string;
  readonly warning?: string;
  readonly markUsedStatus?: SelectedSkillUsageRecordStatus;
  readonly summary?: string;
  readonly selection?: SkillSelectionDecisionFacts;
};
