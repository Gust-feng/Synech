import type { RunAgentDefinitionRef } from "../../domain/config/index.js";
import { agentDefinitionRefMatchesDefinition, runAgentDefinitionRef } from "./agent-definition-ref.js";
import type { AgentDefinition } from "../agent-prompts/contracts.js";

export class AgentDefinitionRegistry {
  private readonly definitionsByRef = new Map<string, AgentDefinition>();

  constructor(definitions: readonly AgentDefinition[]) {
    for (const definition of definitions) {
      const ref = runAgentDefinitionRef(definition);
      const key = agentDefinitionRefKey(ref);
      if (this.definitionsByRef.has(key)) {
        throw new Error(`Duplicate AgentDefinition run ref: ${ref.agentId} / ${ref.promptRef}@${ref.promptVersion}`);
      }
      this.definitionsByRef.set(key, definition);
    }
  }

  resolve(ref: RunAgentDefinitionRef): AgentDefinition | undefined {
    const definition = this.definitionsByRef.get(agentDefinitionRefKey(ref));
    if (definition === undefined) {
      return undefined;
    }
    if (!agentDefinitionRefMatchesDefinition(ref, definition, { allowMissingDefinitionHash: true })) {
      return undefined;
    }
    return definition;
  }
}

function agentDefinitionRefKey(ref: RunAgentDefinitionRef): string {
  return [
    ref.agentId,
    ref.promptRef,
    ref.promptVersion,
    ref.outputContractId,
    ref.toolVisibilityProfileId,
  ].join("\u001f");
}
