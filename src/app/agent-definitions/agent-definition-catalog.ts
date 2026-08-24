import { AgentDefinitionRegistry } from "./agent-definition-registry.js";
import { runAgentDefinitionRef } from "./agent-definition-ref.js";
import type { AgentDefinition } from "../agent-prompts/contracts.js";
import {
  ORDINARY_AGENT,
  ORDINARY_AGENT_ZH,
} from "../agent-prompts/ordinary-agent.js";

export type RuntimeAgentDefinitionCatalogInput = {
  readonly ordinaryAgentDefinition?: AgentDefinition;
  readonly additionalDefinitions?: readonly AgentDefinition[];
};

export type RuntimeAgentDefinitionCatalog = {
  readonly ordinaryAgentDefinition: AgentDefinition;
  readonly registry: AgentDefinitionRegistry;
};

export function createRuntimeAgentDefinitionCatalog(
  input: RuntimeAgentDefinitionCatalogInput = {}
): RuntimeAgentDefinitionCatalog {
  const ordinaryAgentDefinition = input.ordinaryAgentDefinition ?? ORDINARY_AGENT;
  assertOrdinaryAgentDefinition(ordinaryAgentDefinition);
  const builtInDefinitions = definitionsNotAlreadyIncluded(
    [
      ORDINARY_AGENT,
      ORDINARY_AGENT_ZH,
    ],
    [ordinaryAgentDefinition]
  );
  return {
    ordinaryAgentDefinition,
    registry: new AgentDefinitionRegistry([
      ordinaryAgentDefinition,
      ...builtInDefinitions,
      ...(input.additionalDefinitions ?? []),
    ]),
  };
}

function assertOrdinaryAgentDefinition(definition: AgentDefinition): void {
  if (definition.turnPolicy.purpose !== "ordinary_agent") {
    throw new Error(
      `Default Agent definition must use the primary agent purpose: ${definition.agentId} declares ${definition.turnPolicy.purpose}.`
    );
  }
}

function definitionsNotAlreadyIncluded(
  candidates: readonly AgentDefinition[],
  existing: readonly AgentDefinition[]
): readonly AgentDefinition[] {
  return candidates.filter(
    (candidate) => !existing.some((definition) => sameAgentDefinitionRunRef(candidate, definition))
  );
}

function sameAgentDefinitionRunRef(left: AgentDefinition, right: AgentDefinition): boolean {
  const leftRef = runAgentDefinitionRef(left);
  const rightRef = runAgentDefinitionRef(right);
  return (
    leftRef.agentId === rightRef.agentId &&
    leftRef.promptRef === rightRef.promptRef &&
    leftRef.promptVersion === rightRef.promptVersion &&
    leftRef.outputContractId === rightRef.outputContractId &&
    leftRef.toolVisibilityProfileId === rightRef.toolVisibilityProfileId &&
    leftRef.definitionHash === rightRef.definitionHash
  );
}
