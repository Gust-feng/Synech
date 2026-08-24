import type { McpServerSettings } from "../../domain/config/index.js";
import type { ToolExecutor } from "../../domain/tools/index.js";
import {
  DEFAULT_MCP_MAX_CONCURRENT_CALLS_PER_SERVER,
  McpClientWrapper,
  type McpClientConfig,
  type McpToolInfo,
} from "./mcp-client.js";
import {
  assertCachedMcpToolCatalogWithinLimits,
  normalizeCachedMcpToolCatalog,
  type NormalizedCachedMcpToolCatalogEntry,
} from "../../domain/mcp/index.js";
import { createLazyMcpToolExecutor } from "./mcp-tool-adapter.js";

export type LazyMcpToolProviderConfig = {
  readonly servers: readonly McpServerSettings[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly maxConcurrentCallsPerServer?: number;
  readonly managedBinDirectory?: string;
};

export type LazyMcpToolProviderOptions = {
  readonly createClient?: (config: McpClientConfig) => McpClientWrapper;
};

type LazyServerSession = {
  readonly server: McpServerSettings;
  client?: McpClientWrapper;
  connecting?: Promise<McpClientWrapper>;
  connectAbortController?: AbortController;
};

type LazyCachedToolSource = {
  readonly session: LazyServerSession;
  readonly serverId: string;
  readonly tool: McpToolInfo;
  readonly confirmationStrategy: {
    readonly confirmationMode: McpServerSettings["confirmationMode"];
    readonly autoApprovedTools: readonly string[];
  };
};

export class LazyMcpToolExecutorProvider {
  private readonly sessions = new Map<string, LazyServerSession>();
  private readonly cachedTools: readonly NormalizedCachedMcpToolCatalogEntry<LazyCachedToolSource>[];
  private lifecycleGeneration = 0;
  private closed = false;
  private disconnecting?: Promise<void>;

  constructor(
    private readonly config: LazyMcpToolProviderConfig,
    private readonly options: LazyMcpToolProviderOptions = {},
  ) {
    for (const server of config.servers) {
      if (!server.enabled || !hasCompleteRuntimeConfig(server) || (server.cachedTools?.length ?? 0) === 0) {
        continue;
      }
      this.sessions.set(server.serverId, { server });
    }
    this.cachedTools = normalizeCachedMcpToolCatalog(
      [...this.sessions.values()].flatMap((session) =>
        (session.server.cachedTools ?? []).map((tool): LazyCachedToolSource => ({
          session,
          serverId: session.server.serverId,
          tool: tool as McpToolInfo,
          confirmationStrategy: {
            confirmationMode: session.server.confirmationMode,
            autoApprovedTools: session.server.autoApprovedTools,
          },
        })),
      ),
    );
    assertCachedMcpToolCatalogWithinLimits(this.exposedCachedTools());
  }

  getToolsForRegistry(): readonly ToolExecutor[] {
    return this.exposedCachedTools().map(({ session, tool, serverId, definition }) =>
      createLazyMcpToolExecutor(
        () => this.getClient(session),
        tool,
        serverId,
        definition,
      ));
  }

  getDiscoveredToolsForRegistry(): readonly ToolExecutor[] {
    return this.cachedTools.map(({ session, tool, serverId, definition }) =>
      createLazyMcpToolExecutor(
        () => this.getClient(session),
        tool,
        serverId,
        definition,
      ));
  }

  async disconnectAll(): Promise<void> {
    if (this.disconnecting !== undefined) {
      return this.disconnecting;
    }
    this.closed = true;
    this.lifecycleGeneration += 1;
    for (const session of this.sessions.values()) {
      session.connectAbortController?.abort(new Error("Lazy MCP provider is closing."));
    }

    const connecting = [...this.sessions.values()]
      .map((session) => session.connecting)
      .filter((attempt): attempt is Promise<McpClientWrapper> => attempt !== undefined);
    const initiallyConnected = [...this.sessions.values()]
      .map((session) => session.client)
      .filter((client): client is McpClientWrapper => client !== undefined);

    const disconnecting = (async () => {
      // A connecting client owns a transport before it becomes visible as session.client.
      // Wait for every attempt so its stale-path cleanup has completed before release returns.
      await Promise.allSettled(connecting);
      const clients = new Set(initiallyConnected);
      for (const session of this.sessions.values()) {
        if (session.client !== undefined) {
          clients.add(session.client);
        }
      }
      const clientList = [...clients];
      const results = await Promise.allSettled(clientList.map((client) => client.disconnect()));
      const failures: unknown[] = [];
      for (const [index, result] of results.entries()) {
        const client = clientList[index]!;
        if (result.status === "rejected") {
          failures.push(result.reason);
          continue;
        }
        for (const session of this.sessions.values()) {
          if (session.client === client) session.client = undefined;
        }
      }
      for (const session of this.sessions.values()) {
        session.connecting = undefined;
        session.connectAbortController = undefined;
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "One or more lazy MCP clients could not disconnect.");
      }
    })();
    this.disconnecting = disconnecting;
    try {
      await disconnecting;
    } catch (error) {
      if (this.disconnecting === disconnecting) this.disconnecting = undefined;
      throw error;
    }
  }

  private async getClient(session: LazyServerSession): Promise<McpClientWrapper> {
    if (this.closed) {
      throw lazyProviderClosedError();
    }
    if (session.client?.isConnected() === true) {
      return session.client;
    }
    if (session.connecting !== undefined) {
      return session.connecting;
    }
    const clientConfig = mcpClientConfigFromServer(session.server, this.config.env, {
      maxConcurrentCallsPerServer: this.config.maxConcurrentCallsPerServer,
      managedBinDirectory: this.config.managedBinDirectory,
    });
    const client = this.options.createClient?.(clientConfig) ?? new McpClientWrapper(clientConfig);
    const generation = this.lifecycleGeneration;
    const abortController = new AbortController();
    session.connectAbortController = abortController;
    let connecting!: Promise<McpClientWrapper>;
    connecting = client.connect({ signal: abortController.signal }).then(() => {
      if (this.closed || generation !== this.lifecycleGeneration) {
        throw lazyProviderClosedError();
      }
      session.client = client;
      return client;
    }).catch(async (error: unknown) => {
      try {
        await client.disconnect();
      } catch (disconnectError) {
        session.client = client;
        throw new AggregateError(
          [error, disconnectError],
          `Lazy MCP client ${session.server.serverId} failed while closing an incomplete connection.`,
        );
      }
      if (this.closed || generation !== this.lifecycleGeneration) {
        throw lazyProviderClosedError();
      }
      throw error;
    }).finally(() => {
      if (session.connecting === connecting) {
        session.connecting = undefined;
        session.connectAbortController = undefined;
      }
    });
    session.connecting = connecting;
    return connecting;
  }

  private exposedCachedTools(): readonly NormalizedCachedMcpToolCatalogEntry<LazyCachedToolSource>[] {
    return this.cachedTools.filter(({ session, tool }) => isToolEnabled(session.server, tool.name));
  }
}

function lazyProviderClosedError(): Error {
  const error = new Error("Lazy MCP provider is closed.");
  error.name = "AbortError";
  return error;
}

export function mcpClientConfigFromServer(
  server: McpServerSettings,
  env?: Readonly<Record<string, string | undefined>>,
  options: {
    readonly maxConcurrentCallsPerServer?: number;
    readonly managedBinDirectory?: string;
  } = {},
): McpClientConfig {
  return {
    serverId: server.serverId,
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    env: resolveEnvRefs(server.envSecretRefs, env),
    httpHeaders: resolveHttpHeaders(server, env),
    maxConcurrentCalls: options.maxConcurrentCallsPerServer ?? DEFAULT_MCP_MAX_CONCURRENT_CALLS_PER_SERVER,
    managedBinDirectory: options.managedBinDirectory,
  };
}

function resolveEnvRefs(
  envSecretRefs: readonly string[],
  env?: Readonly<Record<string, string | undefined>>
): Record<string, string> | undefined {
  if (envSecretRefs.length === 0 || env === undefined) {
    return undefined;
  }
  const resolved: Record<string, string> = {};
  for (const ref of envSecretRefs) {
    const value = env[ref];
    if (value !== undefined) {
      resolved[ref] = value;
    }
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function resolveHttpHeaders(
  server: McpServerSettings,
  env?: Readonly<Record<string, string | undefined>>
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (server.bearerTokenSecretRef !== undefined) {
    const value = env?.[server.bearerTokenSecretRef];
    if (value !== undefined) {
      headers.Authorization = `Bearer ${value}`;
    }
  }
  if (server.apiKeySecretRef !== undefined) {
    const value = env?.[server.apiKeySecretRef];
    if (value !== undefined) {
      headers[server.apiKeyHeaderName ?? "X-API-Key"] = value;
    }
  }
  for (const ref of server.headerSecretRefs ?? []) {
    const parsed = parseHeaderSecretRef(ref);
    if (parsed === undefined) {
      continue;
    }
    const value = env?.[parsed.secretRef];
    if (value !== undefined) {
      headers[parsed.headerName] = value;
    }
  }
  return Object.keys(headers).length === 0 ? undefined : headers;
}

function parseHeaderSecretRef(value: string): { readonly headerName: string; readonly secretRef: string } | undefined {
  const separator = value.indexOf("=");
  if (separator <= 0) {
    return undefined;
  }
  const headerName = value.slice(0, separator).trim();
  const secretRef = value.slice(separator + 1).trim();
  return headerName.length === 0 || secretRef.length === 0 ? undefined : { headerName, secretRef };
}

function isToolEnabled(server: McpServerSettings, toolName: string): boolean {
  if (server.toolExposureMode === "none") {
    return false;
  }
  if (server.toolExposureMode === "all") {
    return true;
  }
  return server.enabledTools.includes(toolName);
}

function hasCompleteRuntimeConfig(server: McpServerSettings): boolean {
  if (server.transport === "stdio") {
    return server.command !== undefined && server.command.trim().length > 0;
  }
  return server.url !== undefined && server.url.trim().length > 0;
}
