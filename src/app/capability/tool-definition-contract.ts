import { createHash } from "node:crypto";
import type { CapabilityToolCatalogItem } from "../../domain/config/index.js";
import {
  cloneToolInputSchema,
  cloneToolJsonSchema,
  stableToolSchemaStringify,
  type ToolDefinition,
  type ToolInputSchema,
  type ToolJsonSchema,
} from "../../domain/tools/index.js";

type ToolDefinitionContract = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  readonly outputSchema?: ToolJsonSchema;
  readonly metadata: {
    readonly category: NonNullable<ToolDefinition["metadata"]>["category"];
    readonly riskLevel: NonNullable<ToolDefinition["metadata"]>["riskLevel"];
    readonly operationType: NonNullable<ToolDefinition["metadata"]>["operationType"];
    readonly fileOperation?: NonNullable<ToolDefinition["metadata"]>["fileOperation"];
    readonly requiresConfirmation: boolean;
    readonly runtimeHints?: NonNullable<ToolDefinition["metadata"]>["runtimeHints"];
  };
};

export function toolDefinitionContractHash(definition: ToolDefinition): string | undefined {
  if (definition.metadata === undefined) {
    return undefined;
  }
  return hashContract({
    name: definition.name,
    description: definition.description,
    inputSchema: cloneToolInputSchema(definition.inputSchema),
    outputSchema: definition.outputSchema === undefined
      ? undefined
      : cloneToolJsonSchema(definition.outputSchema),
    metadata: {
      category: definition.metadata.category,
      riskLevel: definition.metadata.riskLevel,
      operationType: definition.metadata.operationType,
      fileOperation: definition.metadata.fileOperation,
      requiresConfirmation: definition.metadata.requiresConfirmation,
      runtimeHints: definition.metadata.runtimeHints === undefined
        ? undefined
        : globalThis.structuredClone(definition.metadata.runtimeHints),
    },
  });
}

export function toolCatalogContractHash(
  tool: Pick<
    CapabilityToolCatalogItem,
    | "name"
    | "description"
    | "inputSchema"
    | "outputSchema"
    | "category"
    | "riskLevel"
    | "operationType"
    | "fileOperation"
    | "requiresConfirmation"
    | "runtimeHints"
  > & { readonly inputSchema: ToolInputSchema }
): string {
  return hashContract({
    name: tool.name,
    description: tool.description,
    inputSchema: cloneToolInputSchema(tool.inputSchema),
    outputSchema: tool.outputSchema === undefined
      ? undefined
      : cloneToolJsonSchema(tool.outputSchema),
    metadata: {
      category: tool.category,
      riskLevel: tool.riskLevel,
      operationType: tool.operationType,
      fileOperation: tool.fileOperation,
      requiresConfirmation: tool.requiresConfirmation,
      runtimeHints: tool.runtimeHints === undefined
        ? undefined
        : globalThis.structuredClone(tool.runtimeHints),
    },
  });
}

function hashContract(contract: ToolDefinitionContract): string {
  return `sha256:${createHash("sha256").update(stableToolSchemaStringify(contract)).digest("hex")}`;
}
