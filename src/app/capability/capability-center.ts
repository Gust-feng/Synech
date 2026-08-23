import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ConversationOwner } from "../../domain/execution-scope/index.js";
import type {
  OrdinaryCapabilitySnapshot,
  CapabilitySkillCatalogItem,
  CapabilitySkillCompatibility,
  CapabilitySkillMetadataValue,
  CapabilitySkillProvenance,
  CapabilitySkillProvenanceValue,
  CapabilitySkillResourceIndexItem,
  CapabilityMcpCatalogItem,
  CapabilityMcpToolCatalogItem,
  CapabilityToolCatalogItem,
  CapabilityToolScope,
  CapabilitySubAgentCatalogItem,
  McpServerSettings,
  SanitizedModelProviderConfig,
} from "../../domain/config/index.js";
import type { SkillDefinition } from "../skills/contracts.js";
import {
  cloneToolInputSchema,
  cloneToolJsonSchema,
  canonicalNamespacedToolName,
  canonicalToolName,
  canonicalToolNamespacePrefix,
  toolPresentationForDefinition,
  type ToolDefinition,
} from "../../domain/tools/index.js";
import type { SubAgentDefinition, SubAgentRootInput } from "../sub-agents/sub-agent-loader.js";
import { createId, nowIso } from "../../kernel/id.js";
import { LazyMcpToolExecutorProvider } from "../../adapters/mcp/index.js";
import type { ConfigCenter } from "../config-center/index.js";
import { resolveModelCapabilities } from "../model-runtime/model-capability-registry.js";
import {
  createAgentToolRegistry,
  type ToolRegistryFetchLike,
} from "../tool-center/builtin-tool-runtime.js";
import { applyAgentToolRegistryContributions, type AgentToolRegistryContribution } from "../tool-center/factory.js";
import {
  ToolRegistry,
  type ToolCatalogItem,
  type ToolCatalogSnapshot,
} from "../tool-center/tool-registry.js";
import type { ToolOutputStore } from "../tool-center/tool-output-store.js";
import { discoverSkills, normalizeSkillRoots, parseSkillMarkdown, type SkillRootInput } from "../skills/skill-loader.js";
import type { SkillStateStore } from "../skills/skill-state-store.js";
import { discoverSubAgents, normalizeSubAgentRoots } from "../sub-agents/sub-agent-loader.js";
import { createSubAgentAgentToolCatalogContribution } from "../sub-agents/sub-agent-agent-tools.js";
import { registerSkillResourceTool } from "../skills/skill-resource-tool.js";
import { createMcpToolRegistryContribution } from "../mcp/mcp-tool-contribution.js";
import { toolCatalogContractHash } from "./tool-definition-contract.js";

export type CapabilitySkillRootsInput = {
  readonly executionRoot?: string;
};

export type CapabilitySubAgentRootsInput = {
  readonly executionRoot?: string;
};

export type CapabilityToolContributionsInput = {
  readonly workspaceRoot: string;
  /** Present only when a concrete Conversation owner freezes a run catalog. */
  readonly memoryOwner?: ConversationOwner;
};

export type CapabilityCenterOptions = {
  readonly configCenter: ConfigCenter;
  readonly skillRoots: readonly SkillRootInput[];
  readonly resolveSkillRoots?: (input: CapabilitySkillRootsInput) => readonly SkillRootInput[];
  readonly skillStateStore?: SkillStateStore;
  readonly subAgentRoots?: readonly SubAgentRootInput[];
  readonly resolveSubAgentRoots?: (input: CapabilitySubAgentRootsInput) => readonly SubAgentRootInput[];
  readonly fetch?: ToolRegistryFetchLike;
  readonly playwrightAvailable?: boolean;
  readonly toolOutputStore?: ToolOutputStore;
  /** Host-selected feature tools included in the frozen catalog for this workspace. */
  readonly resolveToolContributions?: (
    input: CapabilityToolContributionsInput,
  ) => readonly AgentToolRegistryContribution[];
  readonly resolveModelCapabilities?: typeof resolveModelCapabilities;
};

export type CapabilityCenterSnapshotInput = {
  readonly executionRoot?: string;
  /** Owner-scoped feature tools must never derive identity from executionRoot. */
  readonly memoryOwner?: ConversationOwner;
};

type CapabilityCenterSnapshotResult = {
  readonly snapshot: OrdinaryCapabilitySnapshot;
  readonly baseToolCatalog: ToolCatalogSnapshot;
};

export class CapabilityCenter {
  private skillsPromises = new Map<string, Promise<readonly SkillDefinition[]>>();
  private subAgentsPromises = new Map<string, Promise<readonly SubAgentDefinition[]>>();
  private snapshotPromise?: Promise<CapabilityCenterSnapshotResult>;

  constructor(private readonly options: CapabilityCenterOptions) {}

  invalidate(): void {
    this.skillsPromises.clear();
    this.subAgentsPromises.clear();
    this.snapshotPromise = undefined;
  }

  async listSkills(input: CapabilitySkillRootsInput = {}): Promise<readonly SkillDefinition[]> {
    const effectiveInput = await this.effectiveSkillRootInput(input);
    const roots = this.skillRootsFor(effectiveInput);
    const cacheKey = skillRootCacheKey(roots);
    const existing = this.skillsPromises.get(cacheKey);
    if (existing !== undefined) {
      return existing;
    }
    {
      const current = discoverSkills({
        roots,
        stateStore: this.options.skillStateStore,
      });
      const cached = current.catch((error) => {
        if (this.skillsPromises.get(cacheKey) === cached) {
          this.skillsPromises.delete(cacheKey);
        }
        throw error;
      });
      this.skillsPromises.set(cacheKey, cached);
    }
    return this.skillsPromises.get(cacheKey)!;
  }

  async listSubAgents(input: CapabilitySubAgentRootsInput = {}): Promise<readonly SubAgentDefinition[]> {
    const effectiveInput = await this.effectiveSubAgentRootInput(input);
    const roots = this.subAgentRootsFor(effectiveInput);
    if (roots.length === 0) {
      return [];
    }
    const cacheKey = subAgentRootCacheKey(roots);
    const existing = this.subAgentsPromises.get(cacheKey);
    if (existing !== undefined) {
      return existing;
    }
    const current = discoverSubAgents({
      roots,
    });
    const cached = current.catch((error) => {
      if (this.subAgentsPromises.get(cacheKey) === cached) {
        this.subAgentsPromises.delete(cacheKey);
      }
      throw error;
    });
    this.subAgentsPromises.set(cacheKey, cached);
    return cached;
  }

  async snapshot(input: CapabilityCenterSnapshotInput = {}): Promise<OrdinaryCapabilitySnapshot> {
    return (await this.snapshotResult(input)).snapshot;
  }

  /** Panel-facing catalog from the same assembly used to freeze Agent run capabilities. */
  async toolCatalog(input: CapabilityCenterSnapshotInput = {}): Promise<ToolCatalogSnapshot> {
    return globalThis.structuredClone((await this.snapshotResult(input)).baseToolCatalog);
  }

  private async snapshotResult(
    input: CapabilityCenterSnapshotInput,
  ): Promise<CapabilityCenterSnapshotResult> {
    if (input.executionRoot !== undefined || input.memoryOwner !== undefined) {
      return this.buildSnapshot(input);
    }
    if (this.snapshotPromise === undefined) {
      const current = this.buildSnapshot();
      const cached = current.catch((error) => {
        if (this.snapshotPromise === cached) {
          this.snapshotPromise = undefined;
        }
        throw error;
      });
      this.snapshotPromise = cached;
    }
    return this.snapshotPromise;
  }

  private async buildSnapshot(input: CapabilityCenterSnapshotInput = {}): Promise<CapabilityCenterSnapshotResult> {
    const [activeModel, overrides, toolStates, toolConfirmation, skillTrigger, mcpServers, commandShell, env] = await Promise.all([
      this.options.configCenter.getModelProviderConfig(),
      this.options.configCenter.listModelCapabilityOverrides(),
      this.options.configCenter.listToolStates(),
      this.options.configCenter.getToolConfirmationConfig(),
      this.options.configCenter.getSkillTriggerConfig(),
      this.options.configCenter.listMcpServers(),
      this.options.configCenter.getCommandShellConfig(),
      this.options.configCenter.createModelRuntimeEnvironment(),
    ]);
    const executionRoot = path.resolve(input.executionRoot ?? process.cwd());
    const [skills, subAgents] = await Promise.all([
      this.listSkills({ executionRoot }),
      this.listSubAgents({ executionRoot }),
    ]);
    const connectableMcpServers = mcpServers.filter(isMcpServerConnectable);
    const cachedMcpServers = connectableMcpServers.filter(hasUsableMcpToolCache);
    const mcpToolProvider = cachedMcpServers.length === 0
      ? undefined
      : new LazyMcpToolExecutorProvider({
          servers: cachedMcpServers,
          env: await this.options.configCenter.createMcpRuntimeEnvironment({
            servers: cachedMcpServers,
            baseEnv: env,
          }),
        });
    const modelCapabilities = (this.options.resolveModelCapabilities ?? resolveModelCapabilities)({ profile: activeModel, overrides });
    const subAgentRoots = this.subAgentRootsFor({ executionRoot });
    const toolRegistryOptions = {
      env,
      fetch: this.options.fetch,
      workspaceRoot: executionRoot,
      playwrightAvailable: this.options.playwrightAvailable,
      toolStates,
      commandShell,
      modelCapabilities,
      baseToolScopes: ["agent-basic"],
      toolOutputStore: this.options.toolOutputStore,
    };
    const registry = new ToolRegistry({
      toolCenter: { outputStore: this.options.toolOutputStore },
    });
    const hostContributions: AgentToolRegistryContribution[] = [
      ...(this.options.resolveToolContributions?.({
        workspaceRoot: executionRoot,
        memoryOwner: input.memoryOwner,
      }) ?? []),
    ];
    applyAgentToolRegistryContributions(registry, { toolStates }, hostContributions);
    createAgentToolRegistry(toolRegistryOptions, registry);
    if (mcpToolProvider !== undefined) {
      applyAgentToolRegistryContributions(registry, { toolStates }, [
        createMcpToolRegistryContribution(mcpToolProvider, { useDiscoveredTools: true }),
      ]);
    }
    registerSkillResourceTool(registry, [], { includeWhenEmpty: true });
    const baseToolCatalog = registry.catalog("agent-basic");
    const mcpToolCatalog = registry.catalog("mcp");
    const exposedMcpToolCatalog = filteredMcpToolCatalog(mcpToolCatalog, mcpServers);
    const subAgentToolCatalog = createSubAgentAgentToolCatalogContribution({
      subAgents,
      dynamicSpawnAvailable: subAgentRoots.length > 0,
    });
    const subAgentTools = subAgentToolCatalog.definitions.map((definition) =>
      catalogOnlyToolItem(definition, subAgentToolCatalog.scopes)
    );
    const allTools = [
      ...baseToolCatalog.tools,
      ...exposedMcpToolCatalog.tools,
      ...subAgentTools,
    ].map(capabilityToolCatalogItem);
    const allAllowedTools = capabilityAllowedToolNames({
      baseAllowedTools: baseToolCatalog.allowedTools,
      mcpAllowedTools: exposedMcpToolCatalog.allowedTools,
      catalogOnlyAllowedTools: subAgentTools.map((tool) => tool.name),
    });
    const warnings = capabilityWarnings({
      activeModel,
      toolCount: allAllowedTools.length,
    });
    const skillCatalog = await Promise.all(skills.map(projectSkillCatalogItem));
    const subAgentCatalog = subAgents.map(projectSubAgentCatalogItem);
    return {
      baseToolCatalog: globalThis.structuredClone(baseToolCatalog),
      snapshot: {
        snapshotId: createId("capability-snapshot"),
        createdAt: nowIso(),
        activeModel,
        modelCapabilities,
        toolCatalog: {
          scope: "agent-basic",
          tools: allTools,
          allowedTools: allAllowedTools,
        },
        skillCatalog,
        subAgentCatalog,
        skillTrigger,
        mcpCatalog: mcpServers.map((server): CapabilityMcpCatalogItem =>
          mcpCatalogItemForServer(server, mcpToolCatalog.tools, exposedMcpToolCatalog.tools)
        ),
        executionRoot,
        commandShell,
        toolConfirmation,
        securitySummary: `本轮模型、工具、技能和执行根能力快照。确认策略：${toolConfirmation.label}。`,
        warnings,
      },
    };
  }

  private async effectiveSkillRootInput(input: CapabilitySkillRootsInput): Promise<CapabilitySkillRootsInput> {
    return input;
  }

  private skillRootsFor(input: CapabilitySkillRootsInput): readonly SkillRootInput[] {
    return this.options.resolveSkillRoots?.(input) ?? this.options.skillRoots;
  }

  private async effectiveSubAgentRootInput(input: CapabilitySubAgentRootsInput): Promise<CapabilitySubAgentRootsInput> {
    return input;
  }

  private subAgentRootsFor(input: CapabilitySubAgentRootsInput): readonly SubAgentRootInput[] {
    return this.options.resolveSubAgentRoots?.(input) ?? this.options.subAgentRoots ?? [];
  }
}

function capabilityAllowedToolNames(input: {
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

function skillRootCacheKey(roots: readonly SkillRootInput[]): string {
  return JSON.stringify(normalizeSkillRoots(roots));
}

function subAgentRootCacheKey(roots: readonly SubAgentRootInput[]): string {
  return JSON.stringify(normalizeSubAgentRoots(roots));
}

async function projectSkillCatalogItem(skill: SkillDefinition): Promise<CapabilitySkillCatalogItem> {
  const base = {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    enabled: skill.enabled,
    sourcePath: skill.sourcePath,
    triggers: [...skill.triggers],
    lastUsedAt: skill.lastUsedAt,
    summary: skill.summary,
    category: skill.category,
    sourceKind: skill.sourceKind,
    sourceRootId: skill.sourceRootId,
    sourcePrecedence: skill.sourcePrecedence,
    stateKey: skill.stateKey,
    version: skill.version,
    provenance: safeSkillProvenance(skill.provenance),
    whenToUse: skill.whenToUse,
    disableModelInvocation: skill.disableModelInvocation,
    userInvocable: skill.userInvocable,
  };
  const resources = await skillResourceIndex(skill);
  let raw: string;
  try {
    raw = await fs.readFile(skill.sourcePath, "utf8");
  } catch {
    return {
      ...base,
      resources,
      validationStatus: "load_error",
      loadError: "无法读取 SKILL.md 元数据。",
      validationErrors: ["skill file could not be read"],
    };
  }

  const parsed = parseSkillMarkdown(raw);
  const frontmatter = parsed.frontmatter;
  const allowedTools = safeStringArray(frontmatter.allowedTools ?? frontmatter["allowed-tools"])
    .filter(isSafeToolName);
  const metadata = safeSkillMetadata(frontmatter.metadata);
  const compatibility = safeSkillCompatibility(frontmatter.compatibility);
  const provenance = safeSkillProvenance(frontmatter.provenance);
  const validationErrors = validateSkillCatalogItem({
    id: base.id,
    name: base.name,
    description: base.description,
    contentHash: parsed.contentHash,
  });

  return {
    ...base,
    summary: skill.summary ?? firstString(frontmatter.summary),
    category: skill.category ?? firstString(frontmatter.category),
    version: skill.version ?? firstString(frontmatter.version),
    provenance: safeSkillProvenance(skill.provenance) ?? provenance,
    whenToUse: skill.whenToUse ?? firstString(frontmatter.when_to_use ?? frontmatter.whenToUse),
    disableModelInvocation: skill.disableModelInvocation ?? booleanOrUndefined(frontmatter["disable-model-invocation"] ?? frontmatter.disableModelInvocation),
    userInvocable: skill.userInvocable ?? booleanOrUndefined(frontmatter["user-invocable"] ?? frontmatter.userInvocable),
    license: firstString(frontmatter.license),
    compatibility,
    metadata,
    allowedTools,
    resources,
    contentHash: parsed.contentHash,
    bodyHash: parsed.bodyHash,
    validationStatus: validationErrors.length === 0 ? "valid" : "invalid",
    validationErrors: validationErrors.length === 0 ? undefined : validationErrors,
  };
}

async function skillResourceIndex(skill: SkillDefinition): Promise<readonly CapabilitySkillResourceIndexItem[]> {
  const agentSkill = skill as SkillDefinition & {
    readonly scripts?: readonly string[];
    readonly references?: readonly string[];
    readonly assets?: readonly string[];
  };
  const resources = [
    ...(agentSkill.scripts ?? []).map((sourcePath) => ({ kind: "script" as const, sourcePath })),
    ...(agentSkill.references ?? []).map((sourcePath) => ({ kind: "reference" as const, sourcePath })),
    ...(agentSkill.assets ?? []).map((sourcePath) => ({ kind: "asset" as const, sourcePath })),
  ];
  return Promise.all(resources.map(async (resource): Promise<CapabilitySkillResourceIndexItem> => {
    try {
      const content = await fs.readFile(resource.sourcePath);
      return {
        kind: resource.kind,
        name: path.basename(resource.sourcePath),
        relativePath: toSkillRelativeResourcePath(skill, resource.sourcePath),
        sourcePath: resource.sourcePath,
        contentHash: hashBuffer(content),
        byteLength: content.byteLength,
      };
    } catch {
      return {
        kind: resource.kind,
        name: path.basename(resource.sourcePath),
        relativePath: toSkillRelativeResourcePath(skill, resource.sourcePath),
        sourcePath: resource.sourcePath,
        loadError: "无法读取资源。",
      };
    }
  }));
}

function toSkillRelativeResourcePath(skill: SkillDefinition, sourcePath: string): string | undefined {
  const candidate = skill as SkillDefinition & { readonly packagePath?: unknown };
  const packagePath = typeof candidate.packagePath === "string" && candidate.packagePath.trim().length > 0
    ? candidate.packagePath
    : path.dirname(skill.sourcePath);
  const relativePath = path.relative(packagePath, sourcePath);
  if (relativePath.length === 0 || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return undefined;
  }
  return relativePath.replace(/\\/g, "/");
}

function safeSkillMetadata(value: unknown): Readonly<Record<string, CapabilitySkillMetadataValue>> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const safe: Record<string, CapabilitySkillMetadataValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isSafeMetadataKey(key)) {
      continue;
    }
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      safe[key] = item;
      continue;
    }
    if (Array.isArray(item) && item.every((entry): entry is string => typeof entry === "string")) {
      safe[key] = item;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function safeSkillProvenance(value: unknown): CapabilitySkillProvenance | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const safe: Record<string, CapabilitySkillProvenanceValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!isSafeMetadataKey(key)) {
      continue;
    }
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      safe[key] = item;
      continue;
    }
    if (Array.isArray(item) && item.every(isProvenanceArrayValue)) {
      safe[key] = item;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function safeSkillCompatibility(value: unknown): CapabilitySkillCompatibility | undefined {
  if (typeof value === "string") {
    return { requirement: value };
  }
  if (Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")) {
    return { requirements: value };
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const safe: Record<string, string | readonly string[]> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      safe[key] = item;
      continue;
    }
    if (Array.isArray(item) && item.every((entry): entry is string => typeof entry === "string")) {
      safe[key] = item;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function validateSkillCatalogItem(skill: {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly contentHash?: string;
}): readonly string[] {
  const errors: string[] = [];
  if (skill.id.trim().length === 0) errors.push("id is required");
  if (skill.name.trim().length === 0) errors.push("name is required");
  if (skill.description.trim().length === 0) errors.push("description is required");
  if (skill.contentHash === undefined) errors.push("content hash is required");
  return errors;
}

function safeStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  }
  const single = firstString(value);
  return single === undefined ? [] : [single];
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeToolName(value: string): boolean {
  return /^[A-Za-z0-9_.:-]+$/.test(value);
}

function isSafeMetadataKey(value: string): boolean {
  return /^[A-Za-z0-9_.:-]+$/.test(value) && !/(?:body|content|path|source|resource|secret|token|key)/i.test(value);
}

function isProvenanceArrayValue(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function hashBuffer(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hasUsableMcpToolCache(server: McpServerSettings): boolean {
  return server.lastError === undefined && (server.cachedTools?.length ?? 0) > 0;
}

function capabilityWarnings(input: {
  readonly activeModel: SanitizedModelProviderConfig;
  readonly toolCount: number;
}): readonly string[] {
  const warnings: string[] = [];
  if (!input.activeModel.secretConfigured) {
    warnings.push("当前模型 profile 未配置 API Key。");
  }
  if (input.activeModel.model === undefined) {
    warnings.push("当前模型 profile 未填写模型名。");
  }
  if (input.toolCount === 0) {
    warnings.push("当前没有可用工具。");
  }
  return warnings;
}

/**
 * 把注册表目录项冻结为能力快照条目（FR-TOOL-001）。
 *
 * CapabilityCenter 只冻结工具契约的原始字段，**不做模型可见集合判定**：
 * 模型可见集合的裁剪在 `capability-policy` 的 `resolveRunCapabilities` 中由
 * `capabilitySnapshot.toolCatalog.tools` ∩ `toolVisibilityProfile` ∩
 * `snapshot.allowedTools` ∩ permission 单一推导得到；裸 ToolCenter 仅执行，
 * 不另立可见集合。
 *
 * 这里冻结的 `requiresConfirmation` 是契约的显式声明值。保守确认默认
 * （缺确认策略时按需确认，FR-TOOL-002）在消费层（capability-policy）通过
 * `resolveEffectiveConfirmationRequirement` 应用，不在快照层重写——保证快照
 * 冻结的是工具自身契约事实，能力推导始终来自单一函数。
 */
function capabilityToolCatalogItem(tool: ToolCatalogItem): CapabilityToolCatalogItem {
  return {
    name: tool.name,
    displayName: tool.displayName,
    displayDescription: tool.displayDescription,
    description: tool.description,
    inputSchema: cloneToolInputSchema(tool.inputSchema),
    outputSchema:
      tool.outputSchema === undefined
        ? undefined
        : cloneToolJsonSchema(tool.outputSchema),
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

function catalogOnlyToolItem(
  definition: ToolDefinition,
  scopes: readonly CapabilityToolScope[],
): ToolCatalogItem {
  const metadata = definition.metadata;
  if (metadata === undefined) {
    throw new Error(`Catalog-only tool ${definition.name} requires execution metadata.`);
  }
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
    catalogOnly: true,
  };
}

function isCapabilityToolScope(value: string): value is CapabilityToolScope {
  return value === "agent-basic" || value === "workspace" || value === "mcp" || value === "research";
}

function mcpCatalogItemForServer(
  server: McpServerSettings,
  discoveredMcpTools: readonly ToolCatalogItem[],
  exposedMcpTools: readonly ToolCatalogItem[]
): CapabilityMcpCatalogItem {
  const availability = server.enabled ? mcpAvailability(server) : "disabled";
  const runtimeStatus = mcpRuntimeStatusFor(server, availability);
  const namespacePrefix = canonicalToolNamespacePrefix(server.serverId);
  const discoveredTools = discoveredMcpTools
    .filter((tool) => tool.name.startsWith(namespacePrefix))
    .map((tool) => capabilityMcpToolCatalogItem(server, tool));
  const exposedTools = exposedMcpTools
    .filter((tool) => tool.name.startsWith(namespacePrefix))
    .map((tool) => capabilityMcpToolCatalogItem(server, tool));
  return {
    serverId: server.serverId,
    label: server.label,
    description: server.description,
    transport: server.transport,
    enabled: server.enabled,
    confirmationMode: server.confirmationMode,
    availability,
    runtimeStatus,
    errorSummary: server.lastError,
    commandSummary: commandSummaryFor(server.command, server.args),
    url: isNetworkMcpTransport(server.transport) ? server.url : undefined,
    envSecretRefCount: server.envSecretRefs.length,
    authSecretRefCount: [
      server.bearerTokenSecretRef,
      server.apiKeySecretRef,
      ...(server.headerSecretRefs ?? []),
    ].filter((ref) => ref !== undefined).length,
    toolExposureMode: server.toolExposureMode,
    enabledTools: [...server.enabledTools],
    autoApprovedTools: [...server.autoApprovedTools],
    lastConnectedAt: server.lastConnectedAt,
    lastError: server.lastError,
    toolsCachedAt: server.toolsCachedAt,
    cachedTools: server.cachedTools === undefined ? undefined : server.cachedTools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: cloneToolInputSchema(tool.inputSchema),
      outputSchema: tool.outputSchema === undefined ? undefined : cloneToolJsonSchema(tool.outputSchema),
      annotations: tool.annotations === undefined ? undefined : { ...tool.annotations },
    })),
    promptCount: server.cachedReferences?.prompts.length,
    resourceCount: server.cachedReferences?.resources.length,
    resourceTemplateCount: server.cachedReferences?.resourceTemplates.length,
    referencesCachedAt: server.referencesCachedAt,
    runtimeConfig: availability === "configured" ? {
      transport: server.transport,
      command: server.transport === "stdio" ? server.command : undefined,
      args: server.transport === "stdio" ? [...(server.args ?? [])] : undefined,
      url: isNetworkMcpTransport(server.transport) ? server.url : undefined,
      envSecretRefs: [...server.envSecretRefs],
      headerSecretRefs: [...(server.headerSecretRefs ?? [])],
      bearerTokenSecretRef: server.bearerTokenSecretRef,
      apiKeySecretRef: server.apiKeySecretRef,
      apiKeyHeaderName: server.apiKeyHeaderName,
      confirmationMode: server.confirmationMode,
      toolExposureMode: server.toolExposureMode,
      enabledTools: [...server.enabledTools],
      autoApprovedTools: [...server.autoApprovedTools],
    } : undefined,
    tools: discoveredTools,
    exposedTools,
    updatedAt: server.updatedAt,
  };
}

function filteredMcpToolCatalog<T extends {
  readonly tools: readonly ToolCatalogItem[];
  readonly allowedTools: readonly string[];
}>(
  catalog: T,
  servers: readonly McpServerSettings[]
): T {
  const configuredServers = canonicalMcpServerMap(servers);
  const tools = catalog.tools.filter((tool) => {
    const server = serverForNamespacedTool(configuredServers, tool.name);
    return server === undefined ? false : isMcpToolEnabledForServer(server, tool.name);
  });
  const allowedToolNames = new Set(tools.map((tool) => tool.name));
  return {
    ...catalog,
    tools,
    allowedTools: catalog.allowedTools.filter((name) => allowedToolNames.has(name)),
  };
}

function serverForNamespacedTool(
  servers: ReadonlyMap<string, McpServerSettings>,
  toolName: string
): McpServerSettings | undefined {
  const separator = toolName.indexOf("__");
  return separator <= 0 ? undefined : servers.get(toolName.slice(0, separator));
}

function canonicalMcpServerMap(
  servers: readonly McpServerSettings[],
): ReadonlyMap<string, McpServerSettings> {
  const result = new Map<string, McpServerSettings>();
  for (const server of servers) {
    const namespace = canonicalToolName(server.serverId);
    const existing = result.get(namespace);
    if (existing !== undefined && existing.serverId !== server.serverId) {
      throw new Error(
        `MCP servers ${existing.serverId} and ${server.serverId} share canonical tool namespace ${namespace}.`,
      );
    }
    result.set(namespace, server);
  }
  return result;
}

function isMcpToolEnabledForServer(server: McpServerSettings, namespacedToolName: string): boolean {
  if (server.toolExposureMode === "none") {
    return false;
  }
  if (server.toolExposureMode === "all") {
    return true;
  }
  const protocolName = mcpProtocolNameForCatalogTool(server, namespacedToolName);
  return protocolName !== undefined && server.enabledTools.includes(protocolName);
}

function capabilityMcpToolCatalogItem(
  server: McpServerSettings,
  tool: ToolCatalogItem,
): CapabilityMcpToolCatalogItem {
  const protocolName = mcpProtocolNameForCatalogTool(server, tool.name);
  if (protocolName === undefined) {
    throw new Error(`MCP catalog tool ${tool.name} has no matching protocol identity on server ${server.serverId}.`);
  }
  return { ...capabilityToolCatalogItem(tool), protocolName };
}

function mcpProtocolNameForCatalogTool(
  server: McpServerSettings,
  namespacedToolName: string,
): string | undefined {
  return server.cachedTools?.find((tool) =>
    canonicalNamespacedToolName(server.serverId, tool.name) === namespacedToolName)?.name;
}

function mcpAvailability(server: {
  readonly transport: "stdio" | "http";
  readonly command?: string;
  readonly url?: string;
}): CapabilityMcpCatalogItem["availability"] {
  if (server.transport === "stdio") {
    return server.command === undefined ? "unavailable" : "configured";
  }
  return server.url === undefined ? "unavailable" : "configured";
}

function mcpRuntimeStatusFor(
  server: McpServerSettings,
  availability: CapabilityMcpCatalogItem["availability"]
): NonNullable<CapabilityMcpCatalogItem["runtimeStatus"]> {
  if (!server.enabled) {
    return "disabled";
  }
  if (availability === "unavailable") {
    return "unavailable";
  }
  if (server.lastError !== undefined) {
    return "error";
  }
  return "configured";
}

function isMcpServerConnectable(server: McpServerSettings): boolean {
  return server.enabled && mcpAvailability(server) === "configured";
}

function isNetworkMcpTransport(transport: McpServerSettings["transport"]): boolean {
  return transport === "http";
}

function commandSummaryFor(command: string | undefined, args: readonly string[] | undefined): string | undefined {
  if (command === undefined) {
    return undefined;
  }
  let previousWasSensitiveFlag = false;
  const safeArgs = (args ?? []).slice(0, 6).map((arg) => {
    const sensitiveFlag = /^--?(?:api[_-]?key|token|secret|password|passwd|bearer)$/i.test(arg);
    const sensitiveKeyValue = /(?:api[_-]?key|token|secret|password|passwd|bearer)\s*[=:]/i.test(arg);
    if (previousWasSensitiveFlag || sensitiveFlag || sensitiveKeyValue || arg.includes("=")) {
      previousWasSensitiveFlag = sensitiveFlag;
      return "[arg]";
    }
    previousWasSensitiveFlag = false;
    return arg;
  });
  return [command, ...safeArgs].join(" ");
}

function projectSubAgentCatalogItem(subAgent: SubAgentDefinition): CapabilitySubAgentCatalogItem {
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
