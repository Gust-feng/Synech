import type { SkillJsonValue } from "./skill-validation.js";

export type SkillDefinition = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly sourcePath: string;
  readonly triggers: readonly string[];
  readonly lastUsedAt?: string;
  readonly summary?: string;
  readonly category?: string;
  readonly sourceKind?: "project" | "user" | "plugin" | "admin" | "custom";
  readonly sourceRootId?: string;
  readonly sourcePrecedence?: number;
  readonly stateKey?: string;
  readonly loadError?: string;
  readonly version?: string;
  readonly provenance?: Readonly<Record<string, SkillJsonValue>>;
  readonly whenToUse?: string;
  readonly disableModelInvocation?: boolean;
  readonly userInvocable?: boolean;
  readonly scripts?: readonly string[];
  readonly references?: readonly string[];
  readonly assets?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly resources?: readonly {
    readonly kind: "script" | "reference" | "asset";
    readonly name: string;
    readonly relativePath?: string;
    readonly sourcePath: string;
    readonly contentHash?: string;
    readonly byteLength?: number;
    readonly loadError?: string;
  }[];
  readonly resourceIndex?: readonly {
    readonly type: "script" | "reference" | "asset" | "eval";
    readonly relativePath: string;
    readonly exists: boolean;
    readonly contentHash?: string;
    readonly byteLength?: number;
  }[];
};

export type SkillSelectionMethod =
  | "explicit"
  | "model"
  | "keyword"
  | "keyword_fallback"
  | "mixed"
  | "unknown"
  | (string & {});

export type SkillSelectionDecisionReason = {
  readonly code: string;
  readonly summary: string;
  readonly skillId?: string;
  readonly skillName?: string;
  readonly confidence?: number;
};

export type SkillSelectionDecisionFacts = {
  readonly selectionMethod: SkillSelectionMethod;
  readonly modelCallRef?: string;
  readonly candidateSkillIds: readonly string[];
  readonly selectedSkillIds: readonly string[];
  readonly omittedReasons?: readonly SkillSelectionDecisionReason[];
  readonly rejectedReasons?: readonly SkillSelectionDecisionReason[];
  readonly confidence?: number;
  readonly reasonSummary?: string;
};
