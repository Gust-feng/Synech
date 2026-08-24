import path from "node:path";

import type { ConversationOwner } from "../../domain/execution-scope/index.js";
import type {
  CapabilityMcpCatalogItem,
  OrdinaryCapabilitySnapshot,
  SanitizedInformationAccessConfig,
} from "../../domain/config/index.js";
import { createId, nowIso } from "../../kernel/id.js";
import type { ConfigCenter } from "../config-center/index.js";
import { resolveModelCapabilities } from "../model-runtime/model-capability-registry.js";
import type { SkillDefinition } from "../skills/contracts.js";
import { discoverSkills, type SkillRootInput } from "../skills/skill-loader.js";
import { createReadSkillResourceTool } from "../skills/skill-resource-tool.js";
import type { SkillStateStore } from "../skills/skill-state-store.js";
import { createSubAgentAgentToolCatalogContribution } from "../sub-agents/sub-agent-agent-tools.js";
import {
  discoverSubAgents,
  type SubAgentDefinition,
  type SubAgentRootInput,
} from "../sub-agents/sub-agent-loader.js";
import { createAgentToolRegistry, type ToolRegistryFetchLike } from "../tool-center/builtin-tool-runtime.js";
import {
  applyAgentToolRegistryContributions,
  type AgentToolRegistryContribution,
} from "../tool-center/factory.js";
import { ToolRegistry, type ToolCatalogSnapshot } from "../tool-center/tool-registry.js";
import type { ToolOutputStore } from "../tool-center/tool-output-store.js";
import {
  cachedMcpToolCatalog,
  filteredMcpToolCatalog,
  mcpCatalogItemForServer,
} from "./mcp-capability-catalog.js";
import { projectSkillCatalogItem, skillRootCacheKey } from "./skill-capability-catalog.js";
import {
  capabilityAllowedToolNames,
  capabilityToolCatalogItem,
  capabilityWarnings,
  projectSubAgentCatalogItem,
  subAgentRootCacheKey,
  toolCatalogItemForDefinition,
} from "./tool-capability-catalog.js";

export type CapabilitySkillRootsInput = { readonly executionRoot?: string };
export type CapabilitySubAgentRootsInput = { readonly executionRoot?: string };

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
  readonly informationAccess?: SanitizedInformationAccessConfig;
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
    if (existing !== undefined) return existing;
    const current = discoverSkills({ roots, stateStore: this.options.skillStateStore });
    const cached = current.catch((error) => {
      if (this.skillsPromises.get(cacheKey) === cached) this.skillsPromises.delete(cacheKey);
      throw error;
    });
    this.skillsPromises.set(cacheKey, cached);
    return cached;
  }

  async listSubAgents(input: CapabilitySubAgentRootsInput = {}): Promise<readonly SubAgentDefinition[]> {
    const effectiveInput = await this.effectiveSubAgentRootInput(input);
    const roots = this.subAgentRootsFor(effectiveInput);
    if (roots.length === 0) return [];
    const cacheKey = subAgentRootCacheKey(roots);
    const existing = this.subAgentsPromises.get(cacheKey);
    if (existing !== undefined) return existing;
    const current = discoverSubAgents({ roots });
    const cached = current.catch((error) => {
      if (this.subAgentsPromises.get(cacheKey) === cached) this.subAgentsPromises.delete(cacheKey);
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

  private async snapshotResult(input: CapabilityCenterSnapshotInput): Promise<CapabilityCenterSnapshotResult> {
    if (input.executionRoot !== undefined || input.memoryOwner !== undefined) return this.buildSnapshot(input);
    if (this.snapshotPromise === undefined) {
      const current = this.buildSnapshot();
      const cached = current.catch((error) => {
        if (this.snapshotPromise === cached) this.snapshotPromise = undefined;
        throw error;
      });
      this.snapshotPromise = cached;
    }
    return this.snapshotPromise;
  }

  private async buildSnapshot(input: CapabilityCenterSnapshotInput = {}): Promise<CapabilityCenterSnapshotResult> {
    const [activeModel, overrides, toolStates, toolConfirmation, skillTrigger, mcpServers, commandShell, env, webSearch] = await Promise.all([
      this.options.configCenter.getModelProviderConfig(),
      this.options.configCenter.listModelCapabilityOverrides(),
      this.options.configCenter.listToolStates(),
      this.options.configCenter.getToolConfirmationConfig(),
      this.options.configCenter.getSkillTriggerConfig(),
      this.options.configCenter.listMcpServers(),
      this.options.configCenter.getCommandShellConfig(),
      this.options.configCenter.createModelRuntimeEnvironment(),
      this.options.configCenter.resolveWebSearchRuntimeConfig(input.informationAccess?.web),
    ]);
    const executionRoot = path.resolve(input.executionRoot ?? process.cwd());
    const [skills, subAgents] = await Promise.all([
      this.listSkills({ executionRoot }),
      this.listSubAgents({ executionRoot }),
    ]);
    const modelCapabilities = (this.options.resolveModelCapabilities ?? resolveModelCapabilities)({
      profile: activeModel,
      overrides,
    });
    const subAgentRoots = this.subAgentRootsFor({ executionRoot });
    const registry = new ToolRegistry({ toolCenter: { outputStore: this.options.toolOutputStore } });
    const hostContributions = this.options.resolveToolContributions?.({
      workspaceRoot: executionRoot,
      memoryOwner: input.memoryOwner,
    }) ?? [];
    applyAgentToolRegistryContributions(registry, { toolStates }, hostContributions);
    createAgentToolRegistry({
      env,
      webSearch,
      fetch: this.options.fetch,
      workspaceRoot: executionRoot,
      playwrightAvailable: this.options.playwrightAvailable,
      toolStates,
      commandShell,
      modelCapabilities,
      baseToolScopes: ["agent-basic"],
      toolOutputStore: this.options.toolOutputStore,
    }, registry);
    registry.register({
      executor: createReadSkillResourceTool([]),
      scopes: ["agent-basic"],
      enabledByDefault: true,
    });
    const baseToolCatalog = registry.catalog("agent-basic");
    const mcpToolCatalog = cachedMcpToolCatalog(mcpServers);
    const exposedMcpToolCatalog = filteredMcpToolCatalog(mcpToolCatalog, mcpServers);
    const subAgentToolCatalog = createSubAgentAgentToolCatalogContribution({
      subAgents,
      dynamicSpawnAvailable: subAgentRoots.length > 0,
    });
    const subAgentTools = subAgentToolCatalog.definitions.map((definition) =>
      toolCatalogItemForDefinition(definition, subAgentToolCatalog.scopes, true));
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
    return {
      baseToolCatalog: globalThis.structuredClone(baseToolCatalog),
      snapshot: {
        snapshotId: createId("capability-snapshot"),
        createdAt: nowIso(),
        activeModel,
        modelCapabilities,
        toolCatalog: { scope: "agent-basic", tools: allTools, allowedTools: allAllowedTools },
        skillCatalog: await Promise.all(skills.map(projectSkillCatalogItem)),
        subAgentCatalog: subAgents.map(projectSubAgentCatalogItem),
        skillTrigger,
        mcpCatalog: mcpServers.map((server): CapabilityMcpCatalogItem =>
          mcpCatalogItemForServer(server, mcpToolCatalog.tools, exposedMcpToolCatalog.tools)),
        executionRoot,
        commandShell,
        toolConfirmation,
        warnings: capabilityWarnings({ activeModel, toolCount: allAllowedTools.length }),
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
