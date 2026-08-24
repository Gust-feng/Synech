import type {
  CapabilitySubAgentCatalogItem,
  CapabilityToolCatalogItem,
  CapabilityToolScope,
  SanitizedModelProviderConfig,
} from "../../domain/config/index.js";
import {
  cloneToolInputSchema,
  cloneToolJsonSchema,
  toolPresentationForDefinition,
  type ToolDefinition,
} from "../../domain/tools/index.js";
import { normalizeSubAgentRoots, type SubAgentDefinition, type SubAgentRootInput } from "../sub-agents/sub-agent-loader.js";
import type { ToolCatalogItem } from "../tool-center/tool-registry.js";
import { toolCatalogContractHash } from "./tool-definition-contract.js";

export function capabilityAllowedToolNames(input: {
  readonly baseAllowedTools: readonly string[];
  readonly mcpAllowedTools: readonly string[];
  readonly catalogOnlyAllowedTools: readonly string[];
}): readonly string[] {
  return [
    ...input.baseAllowedTools.filter((name) => name !== "SkillRead"),
    ...input.mcpAllowedTools,
    ...input.catalogOnlyAllowedTools,
  ];
}

export function capabilityWarnings(input: {
  readonly activeModel: SanitizedModelProviderConfig;
  readonly toolCount: number;
}): readonly string[] {
  const warnings: string[] = [];
  if (!input.activeModel.secretConfigured) warnings.push("当前模型 profile 未配置 API Key。");
  if (input.activeModel.model === undefined) warnings.push("当前模型 profile 未填写模型名。");
  if (input.toolCount === 0) warnings.push("当前没有可用工具。");
  return warnings;
}

export function capabilityToolCatalogItem(tool: ToolCatalogItem): CapabilityToolCatalogItem {
  return {
    name: tool.name,
    displayName: tool.displayName,
    displayDescription: tool.displayDescription,
    description: tool.description,
    inputSchema: cloneToolInputSchema(tool.inputSchema),
    outputSchema: tool.outputSchema === undefined ? undefined : cloneToolJsonSchema(tool.outputSchema),
    category: tool.category,
    categoryLabel: tool.categoryLabel,
    riskLevel: tool.riskLevel,
    riskLabel: tool.riskLabel,
    operationType: tool.operationType,
    fileOperation: tool.fileOperation,
    operationLabel: tool.operationLabel,
    requiresConfirmation: tool.requiresConfirmation,
    confirmationLabel: tool.confirmationLabel,
    runtimeHints: tool.runtimeHints,
    definitionHash: toolCatalogContractHash(tool),
    scopes: tool.scopes.filter(isCapabilityToolScope),
    enabled: tool.enabledByDefault,
    availability: tool.availability,
    disabledReason: tool.disabledReason,
    ...(tool.catalogOnly === true ? { catalogOnly: true } : {}),
  };
}

export function toolCatalogItemForDefinition(
  definition: ToolDefinition,
  scopes: readonly CapabilityToolScope[],
  catalogOnly = false,
): ToolCatalogItem {
  const metadata = definition.metadata;
  if (metadata === undefined) throw new Error(`Tool ${definition.name} requires execution metadata.`);
  const presentation = toolPresentationForDefinition(definition);
  return {
    name: definition.name,
    displayName: presentation.displayName,
    displayDescription: presentation.displayDescription,
    description: definition.description,
    inputSchema: cloneToolInputSchema(definition.inputSchema),
    outputSchema: definition.outputSchema === undefined
      ? undefined
      : cloneToolJsonSchema(definition.outputSchema),
    category: metadata.category,
    categoryLabel: presentation.categoryLabel,
    riskLevel: metadata.riskLevel,
    riskLabel: presentation.riskLabel,
    operationType: metadata.operationType,
    fileOperation: metadata.fileOperation,
    operationLabel: presentation.operationLabel,
    requiresConfirmation: metadata.requiresConfirmation,
    confirmationLabel: presentation.confirmationLabel,
    runtimeHints: metadata.runtimeHints,
    scopes,
    enabledByDefault: true,
    availability: "available",
    ...(catalogOnly ? { catalogOnly: true } : {}),
  };
}

export function subAgentRootCacheKey(roots: readonly SubAgentRootInput[]): string {
  return JSON.stringify(normalizeSubAgentRoots(roots));
}

export function projectSubAgentCatalogItem(subAgent: SubAgentDefinition): CapabilitySubAgentCatalogItem {
  const diagnostics = [
    ...(subAgent.validationErrors ?? []).map((issue) => ({ ...issue, severity: "error" as const })),
    ...(subAgent.validationWarnings ?? []).map((issue) => ({ ...issue, severity: "warning" as const })),
  ];
  return {
    id: subAgent.id,
    name: subAgent.name,
    description: subAgent.description,
    category: subAgent.category,
    sourceKind: subAgent.sourceKind,
    sourceRootId: subAgent.sourceRootId,
    sourcePrecedence: subAgent.sourcePrecedence,
    enabled: subAgent.enabled,
    version: subAgent.version,
    whenToUse: subAgent.whenToUse,
    whenNotToUse: subAgent.whenNotToUse,
    allowedTools: subAgent.allowedTools,
    diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
    contentHash: subAgent.contentHash,
    bodyHash: subAgent.bodyHash,
  };
}

function isCapabilityToolScope(value: string): value is CapabilityToolScope {
  return value === "agent-basic" || value === "workspace" || value === "mcp" || value === "research";
}
