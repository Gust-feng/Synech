import { createHash } from "node:crypto";
import type { RunAgentDefinitionRef } from "../../domain/config/index.js";
import type { AgentDefinition } from "../agent-prompts/contracts.js";

export type CompleteRunAgentDefinitionRef = RunAgentDefinitionRef & {
  readonly definitionHash: string;
};

export function runAgentDefinitionRef(definition: AgentDefinition): RunAgentDefinitionRef {
  return {
    agentId: definition.agentId,
    agentDisplayName: definition.displayName,
    promptRef: definition.prompt.promptRef,
    promptVersion: definition.prompt.version,
    outputContractId: definition.outputContract.contractId,
    toolVisibilityProfileId: definition.toolVisibilityProfile.profileId,
    definitionHash: agentDefinitionHash(definition),
  };
}

export function runAgentDefinitionRefCacheKey(ref: RunAgentDefinitionRef): string {
  return [
    ref.agentId,
    ref.promptRef,
    ref.promptVersion,
    ref.outputContractId,
    ref.toolVisibilityProfileId,
    ref.definitionHash ?? "",
  ].join("\u001f");
}

export function isCompleteRunAgentDefinitionRef(ref: unknown): ref is CompleteRunAgentDefinitionRef {
  if (!isRecord(ref)) {
    return false;
  }
  return (
    isNonEmptyString(ref.agentId) &&
    typeof ref.agentDisplayName === "string" &&
    isNonEmptyString(ref.promptRef) &&
    isNonEmptyString(ref.promptVersion) &&
    isNonEmptyString(ref.outputContractId) &&
    isNonEmptyString(ref.toolVisibilityProfileId) &&
    isDefinitionHash(ref.definitionHash)
  );
}

export function agentDefinitionRefMatchesDefinition(
  ref: RunAgentDefinitionRef,
  definition: AgentDefinition,
  options: {
    readonly allowMissingDefinitionHash?: boolean;
  } = {}
): boolean {
  const expectedRef = runAgentDefinitionRef(definition);
  if (
    ref.agentId !== expectedRef.agentId ||
    ref.promptRef !== expectedRef.promptRef ||
    ref.promptVersion !== expectedRef.promptVersion ||
    ref.outputContractId !== expectedRef.outputContractId ||
    ref.toolVisibilityProfileId !== expectedRef.toolVisibilityProfileId
  ) {
    return false;
  }
  if (ref.definitionHash === undefined) {
    return options.allowMissingDefinitionHash === true;
  }
  return ref.definitionHash === expectedRef.definitionHash;
}

export function agentDefinitionHash(definition: AgentDefinition): string {
  const semanticDefinition = {
    agentId: definition.agentId,
    prompt: definition.prompt,
    turnPolicy: definition.turnPolicy,
    outputContract: definition.outputContract,
    toolVisibilityProfile: definition.toolVisibilityProfile,
  };
  return `sha256:${createHash("sha256").update(stableJson(semanticDefinition)).digest("hex")}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDefinitionHash(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("sha256:") && value.length > "sha256:".length;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, stableJsonValue(record[key])])
  );
}
