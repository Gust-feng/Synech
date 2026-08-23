import {
  discoverSubAgents,
  type SubAgentDefinition,
  type SubAgentDiscoveryOptions,
  type SubAgentRootInput,
  type SubAgentSourceKind,
} from "./sub-agent-loader.js";
import type { CapabilitySubAgentCatalogItem } from "../../domain/config/index.js";

export type { SubAgentDefinition, SubAgentDiscoveryOptions } from "./sub-agent-loader.js";

export type FrozenSubAgentCatalogOptions = {
  readonly roots: readonly SubAgentRootInput[];
  readonly catalog: readonly CapabilitySubAgentCatalogItem[];
};

export class SubAgentRegistry {
  readonly #options: SubAgentDiscoveryOptions | FrozenSubAgentCatalogOptions;
  #cache: readonly SubAgentDefinition[] | null = null;
  #byId: ReadonlyMap<string, SubAgentDefinition> | null = null;
  #byName: ReadonlyMap<string, SubAgentDefinition> | null = null;

  constructor(options: SubAgentDiscoveryOptions | FrozenSubAgentCatalogOptions) {
    this.#options = options;
  }

  async list(): Promise<readonly SubAgentDefinition[]> {
    if (this.#cache === null) {
      const subAgents = await subAgentsForRegistryOptions(this.#options);
      this.#cache = subAgents;
      this.#byId = new Map(subAgents.map((sa) => [sa.id, sa]));
      this.#byName = new Map(subAgents.map((sa) => [sa.name.toLowerCase(), sa]));
    }
    return this.#cache;
  }

  async getById(id: string): Promise<SubAgentDefinition | undefined> {
    await this.list();
    return this.#byId?.get(id);
  }

  async getByName(name: string): Promise<SubAgentDefinition | undefined> {
    await this.list();
    return this.#byName?.get(name.toLowerCase());
  }

  invalidate(): void {
    this.#cache = null;
    this.#byId = null;
    this.#byName = null;
  }
}

async function subAgentsForRegistryOptions(
  options: SubAgentDiscoveryOptions | FrozenSubAgentCatalogOptions
): Promise<readonly SubAgentDefinition[]> {
  if (!isFrozenSubAgentCatalogOptions(options)) {
    return discoverSubAgents(options);
  }
  const discovered = await discoverSubAgents({ roots: options.roots });
  return reconcileFrozenSubAgentCatalog({
    catalog: options.catalog,
    discovered,
  });
}

function isFrozenSubAgentCatalogOptions(
  options: SubAgentDiscoveryOptions | FrozenSubAgentCatalogOptions
): options is FrozenSubAgentCatalogOptions {
  return "catalog" in options;
}

function reconcileFrozenSubAgentCatalog(input: {
  readonly catalog: readonly CapabilitySubAgentCatalogItem[];
  readonly discovered: readonly SubAgentDefinition[];
}): readonly SubAgentDefinition[] {
  const discoveredById = new Map(input.discovered.map((subAgent) => [normalizeSubAgentKey(subAgent.id), subAgent]));
  const discoveredByName = new Map(input.discovered.map((subAgent) => [normalizeSubAgentKey(subAgent.name), subAgent]));
  return input.catalog.map((item) => {
    const discovered =
      discoveredById.get(normalizeSubAgentKey(item.id)) ??
      discoveredByName.get(normalizeSubAgentKey(item.name));
    if (discovered === undefined) {
      return unavailableFrozenSubAgent(item, "Frozen sub-agent is no longer discoverable in this run workspace.");
    }
    if (!hasFrozenExecutionHashes(item)) {
      return {
        ...frozenSubAgentFromDiscovered(discovered, item),
        enabled: false,
        loadError: "Frozen sub-agent catalog is missing execution hashes.",
      };
    }
    return frozenSubAgentFromDiscovered(discovered, item);
  });
}

function frozenSubAgentFromDiscovered(
  discovered: SubAgentDefinition,
  frozen: CapabilitySubAgentCatalogItem & { readonly contentHash?: string; readonly bodyHash?: string }
): SubAgentDefinition {
  return {
    ...discovered,
    id: frozen.id,
    name: frozen.name,
    description: frozen.description,
    enabled: frozen.enabled,
    version: frozen.version,
    category: frozen.category,
    whenToUse: [...(frozen.whenToUse ?? [])],
    whenNotToUse: [...(frozen.whenNotToUse ?? [])],
    allowedTools: [...(frozen.allowedTools ?? [])],
    sourceKind: runtimeSourceKind(frozen.sourceKind, discovered.sourceKind),
    sourceRootId: frozen.sourceRootId,
    sourcePrecedence: frozen.sourcePrecedence,
    contentHash: frozen.contentHash ?? "",
    bodyHash: frozen.bodyHash ?? "",
    metadataHash: "",
  };
}

function unavailableFrozenSubAgent(
  frozen: CapabilitySubAgentCatalogItem,
  loadError: string
): SubAgentDefinition {
  return {
    id: frozen.id,
    name: frozen.name,
    description: frozen.description,
    enabled: false,
    sourcePath: "",
    version: frozen.version,
    category: frozen.category,
    whenToUse: [...(frozen.whenToUse ?? [])],
    whenNotToUse: [...(frozen.whenNotToUse ?? [])],
    allowedTools: [...(frozen.allowedTools ?? [])],
    sourceKind: runtimeSourceKind(frozen.sourceKind),
    sourceRootId: frozen.sourceRootId,
    sourcePrecedence: frozen.sourcePrecedence,
    sourceRootPath: "",
    packageName: frozen.name,
    packagePath: "",
    loadError,
    contentHash: frozen.contentHash ?? "",
    bodyHash: frozen.bodyHash ?? "",
    metadataHash: "",
  };
}

function hasFrozenExecutionHashes(
  item: CapabilitySubAgentCatalogItem
): item is CapabilitySubAgentCatalogItem & { readonly contentHash: string; readonly bodyHash: string } {
  return hashIsPresent(item.contentHash) && hashIsPresent(item.bodyHash);
}

function hashIsPresent(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function normalizeSubAgentKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "sub-agent";
}

function runtimeSourceKind(value: string, fallback: SubAgentSourceKind = "custom"): SubAgentSourceKind {
  return value === "builtin" || value === "project" || value === "user" || value === "custom"
    ? value
    : fallback;
}