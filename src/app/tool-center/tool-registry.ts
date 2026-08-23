import type {
  ToolCategory,
  ToolDefinition,
  ToolDefinitionMetadata,
  ToolExecutionGateway,
  ToolExecutor,
  ToolFileDisplayOperation,
  ToolInputSchema,
  ToolOperationType,
  ToolRiskLevel,
  ToolRuntimeHint,
} from "../../domain/tools/index.js";
import {
  assertCanonicalToolName,
  cloneToolInputSchema,
  cloneToolJsonSchema,
  toolPresentationForDefinition,
  validateModelVisibleToolContract,
} from "../../domain/tools/index.js";
import { ToolCenter, type ToolCenterOptions } from "./tool-center.js";

export type ToolRegistryScope = string;

export type ToolRegistryEntry = {
  readonly executor: ToolExecutor;
  readonly scopes: readonly ToolRegistryScope[];
  readonly enabledByDefault: boolean;
  readonly availability?: ToolRegistryAvailability;
};

export type ToolRegistryAvailability =
  | { readonly status: "available" }
  | { readonly status: "unavailable"; readonly disabledReason: string };

export type ToolCatalogItem = {
  readonly name: string;
  readonly displayName: string;
  readonly displayDescription: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  readonly outputSchema?: ToolDefinition["outputSchema"];
  readonly category: ToolCategory;
  readonly categoryLabel: string;
  readonly riskLevel: ToolRiskLevel;
  readonly riskLabel: string;
  readonly operationType: ToolOperationType;
  readonly fileOperation?: ToolFileDisplayOperation;
  readonly operationLabel: string;
  readonly requiresConfirmation: boolean;
  readonly confirmationLabel: string;
  readonly runtimeHints?: readonly ToolRuntimeHint[];
  readonly scopes: readonly ToolRegistryScope[];
  readonly enabledByDefault: boolean;
  readonly availability: ToolRegistryAvailability["status"];
  readonly disabledReason?: string;
  /** Definition is intentionally model-catalog-only and has no ToolCenter executor. */
  readonly catalogOnly?: boolean;
};

export type ToolCatalogSnapshot = {
  readonly scope: ToolRegistryScope;
  readonly tools: readonly ToolCatalogItem[];
  readonly allowedTools: readonly string[];
};

export type ToolRegistryOptions = {
  readonly toolCenter?: ToolCenterOptions;
};

export class ToolRegistry {
  private readonly entries = new Map<string, ToolRegistryEntry>();

  constructor(private readonly options: ToolRegistryOptions = {}) {}

  register(entry: ToolRegistryEntry): void {
    assertCanonicalToolName(entry.executor.definition.name);
    if (this.entries.has(entry.executor.definition.name)) {
      throw new Error(`Tool ${entry.executor.definition.name} is already registered.`);
    }
    const metadata = requireToolMetadata(entry.executor.definition);
    const scopes = uniqueScopes(entry.scopes);
    const availability = entry.availability ?? { status: "available" as const };
    assertModelVisibleToolContract({
      definition: entry.executor.definition,
      scopes,
      enabledByDefault: entry.enabledByDefault,
      availability,
    });
    this.entries.set(entry.executor.definition.name, {
      executor: {
        ...entry.executor,
        definition: {
          ...entry.executor.definition,
          inputSchema: cloneToolInputSchema(entry.executor.definition.inputSchema),
          outputSchema:
            entry.executor.definition.outputSchema === undefined
              ? undefined
              : cloneToolJsonSchema(entry.executor.definition.outputSchema),
          metadata,
        },
      },
      scopes,
      enabledByDefault: entry.enabledByDefault,
      availability,
    });
  }

  createToolCenter(scope: ToolRegistryScope): ToolExecutionGateway {
    return this.createToolCenterForScopes([scope]);
  }

  createToolCenterForScopes(scopes: readonly ToolRegistryScope[]): ToolExecutionGateway {
    const center = new ToolCenter(this.options.toolCenter);
    for (const entry of this.entriesForAnyScope(scopes)) {
      const availability = entry.availability ?? { status: "available" as const };
      if (entry.enabledByDefault && availability.status === "available") {
        center.register(entry.executor);
      }
    }
    return center;
  }

  catalog(scope: ToolRegistryScope): ToolCatalogSnapshot {
    const tools = this.entriesForScope(scope)
      .map((entry): ToolCatalogItem => {
        const definition = entry.executor.definition;
        const metadata = requireToolMetadata(definition);
        const availability = entry.availability ?? { status: "available" as const };
        const presentation = toolPresentationForDefinition(definition);
        return {
          name: definition.name,
          displayName: presentation.displayName,
          displayDescription: presentation.displayDescription,
          description: definition.description,
          inputSchema: cloneInputSchema(definition.inputSchema),
          outputSchema:
            definition.outputSchema === undefined
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
          runtimeHints: cloneRuntimeHints(metadata.runtimeHints),
          scopes: [...entry.scopes],
          enabledByDefault: entry.enabledByDefault,
          availability: availability.status,
          disabledReason: availability.status === "unavailable" ? availability.disabledReason : undefined,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      scope,
      tools,
      allowedTools: tools.filter((tool) => tool.enabledByDefault && tool.availability === "available").map((tool) => tool.name),
    };
  }

  private entriesForScope(scope: ToolRegistryScope): readonly ToolRegistryEntry[] {
    return [...this.entries.values()].filter((entry) => entry.scopes.includes(scope));
  }

  private entriesForAnyScope(scopes: readonly ToolRegistryScope[]): readonly ToolRegistryEntry[] {
    const requested = new Set(scopes);
    return [...this.entries.values()].filter((entry) => entry.scopes.some((scope) => requested.has(scope)));
  }
}

function cloneInputSchema(value: ToolInputSchema): ToolInputSchema {
  return cloneToolInputSchema(value);
}

export function requireToolMetadata(definition: ToolDefinition): ToolDefinitionMetadata {
  const metadata = definition.metadata;
  if (metadata === undefined) {
    throw new Error(`Tool ${definition.name} cannot enter a registry without metadata.`);
  }
  if (!isToolCategory(metadata.category)) {
    throw new Error(`Tool ${definition.name} has invalid category metadata.`);
  }
  if (!isRiskLevel(metadata.riskLevel)) {
    throw new Error(`Tool ${definition.name} has invalid risk metadata.`);
  }
  if (!isOperationType(metadata.operationType)) {
    throw new Error(`Tool ${definition.name} has invalid operation metadata.`);
  }
  return {
    category: metadata.category,
    riskLevel: metadata.riskLevel,
    operationType: metadata.operationType,
    fileOperation: metadata.fileOperation,
    requiresConfirmation: metadata.requiresConfirmation,
    runtimeHints: cloneRuntimeHints(metadata.runtimeHints),
  };
}

function cloneRuntimeHints(value: ToolDefinitionMetadata["runtimeHints"]): ToolDefinitionMetadata["runtimeHints"] {
  if (value === undefined) {
    return undefined;
  }
  return value.map((hint) => {
    if (hint.kind === "command_shell") {
      return {
        ...hint,
        invocation: [...hint.invocation],
        notes: [...hint.notes],
      };
    }
    return hint;
  });
}

function uniqueScopes(scopes: readonly ToolRegistryScope[]): readonly ToolRegistryScope[] {
  const source: readonly ToolRegistryScope[] = scopes.length === 0 ? ["agent-basic"] : scopes;
  return [...new Set<ToolRegistryScope>(source)];
}

/**
 * 「进模型可见集合」的硬门槛（FR-TOOL-001 / FR-TOOL-002）。
 *
 * 这里只校验 executor identity、客观 description、input schema 和执行/副作用元数据。
 * 真实 result/continuation 边界由
 * ToolCenter 与 executor 行为契约验证，不用散文字段代替。
 *
 * scope 是 Host 自定义的路由标签，不能决定契约是否完整；所有默认启用且可用的
 * registry entry 都必须满足同一事实契约，不依赖工具名关键词或硬编码白名单。
 */
export function assertModelVisibleToolContract(input: {
  readonly definition: ToolDefinition;
  readonly scopes: readonly ToolRegistryScope[];
  readonly enabledByDefault: boolean;
  readonly availability: ToolRegistryAvailability;
}): void {
  if (!shouldRequireModelContract(input)) {
    return;
  }
  const validation = validateModelVisibleToolContract(input.definition);
  if (!validation.ok) {
    throw new Error(
      `Model-visible tool ${input.definition.name} is missing required contract fields: ${validation.missing.join(", ")}.`
    );
  }
}

function shouldRequireModelContract(input: {
  readonly scopes: readonly ToolRegistryScope[];
  readonly enabledByDefault: boolean;
  readonly availability: ToolRegistryAvailability;
}): boolean {
  if (!input.enabledByDefault || input.availability.status !== "available") {
    return false;
  }
  return true;
}

function isToolCategory(value: unknown): value is ToolCategory {
  return value === "research" || value === "workspace" || value === "filesystem" || value === "terminal" || value === "web" || value === "mcp" || value === "other";
}

function isRiskLevel(value: unknown): value is ToolRiskLevel {
  return value === "low" || value === "medium" || value === "high";
}

function isOperationType(value: unknown): value is ToolOperationType {
  return value === "read-only" || value === "read-write" || value === "execute" || value === "external-submit";
}
