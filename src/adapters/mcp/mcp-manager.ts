import type { McpServerSettings } from "../../domain/config/index.js";
import { createMcpToolDefinition } from "../../domain/mcp/index.js";
import type { ToolExecutor } from "../../domain/tools/index.js";
import type { McpClientConfig, McpClientHealth, McpReferenceInfo, McpToolInfo } from "./mcp-client.js";
import { DEFAULT_MCP_MAX_CONCURRENT_CALLS_PER_SERVER, McpClientWrapper } from "./mcp-client.js";
import { createLazyMcpToolExecutor } from "./mcp-tool-adapter.js";

export type McpManagerConfig = {
  readonly servers: readonly McpServerSettings[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly connectTimeoutMs?: number;
  readonly maxConcurrentCallsPerServer?: number;
  readonly managedBinDirectory?: string;
};

export type McpManagerOptions = {
  readonly createClient?: (config: McpClientConfig) => McpClientWrapper;
};

export type McpServerStatus = "disconnected" | "connecting" | "connected" | "error";

export type McpServerRuntimeSnapshot = {
  readonly serverId: string;
  readonly status: McpServerStatus;
  readonly errorSummary?: string;
  readonly lastConnectedAt?: string;
  readonly toolNames: readonly string[];
  readonly health: McpClientHealth;
  readonly activeToolCalls: number;
  readonly queuedToolCalls: number;
  readonly maxConcurrentCalls?: number;
  readonly lastCallFailure?: {
    readonly message: string;
    readonly recordedAt: string;
  };
};

type ServerEntry = {
  client: McpClientWrapper;
  readonly config: McpServerSettings;
  status: McpServerStatus;
  tools: readonly McpToolInfo[];
  connecting?: Promise<McpClientWrapper>;
  errorMessage?: string;
  lastConnectedAt?: string;
};

export class McpManager {
  private readonly entries = new Map<string, ServerEntry>();
  private readonly connectTimeoutMs: number;

  constructor(config: McpManagerConfig, options: McpManagerOptions = {}) {
    this.connectTimeoutMs = Math.max(10, Math.floor(config.connectTimeoutMs ?? 3_000));
    const maxConcurrentCalls = config.maxConcurrentCallsPerServer ?? DEFAULT_MCP_MAX_CONCURRENT_CALLS_PER_SERVER;
    for (const server of config.servers) {
      if (!server.enabled || !hasCompleteRuntimeConfig(server)) {
        continue;
      }
      const resolvedEnv = resolveEnvRefs(server.envSecretRefs, config.env);
      const transport = runtimeTransport(server);
      if (transport === undefined) {
        continue;
      }
      const clientConfig: McpClientConfig = {
        serverId: server.serverId,
        transport,
        command: server.command,
        args: server.args,
        url: server.url,
        env: resolvedEnv,
        httpHeaders: resolveHttpHeaders(server, config.env),
        managedBinDirectory: config.managedBinDirectory,
        maxConcurrentCalls,
      };
      const client = options.createClient?.(clientConfig) ?? new McpClientWrapper(clientConfig);
      const entry: ServerEntry = {
        client,
        config: server,
        status: "disconnected",
        tools: [],
      };
      client.subscribeConnectionState((state) => {
        if (state.connected || entry.status !== "connected") return;
        entry.status = "disconnected";
        entry.errorMessage = state.error === undefined
          ? undefined
          : mcpErrorMessage(state.error instanceof Error ? state.error.message : String(state.error));
      });
      this.entries.set(server.serverId, entry);
    }
  }

  async connectAll(): Promise<void> {
    const promises = [...this.entries.values()].map((entry) => this.connectEntry(entry));
    await Promise.allSettled(promises);
  }

  async disconnectAll(): Promise<void> {
    const promises = [...this.entries.values()].map(async (entry) => {
      try {
        await withTimeout(
          entry.client.disconnect(),
          this.connectTimeoutMs + 5_000,
          `MCP server "${entry.config.serverId}" did not close before timeout.`
        );
      } catch {
      }
      entry.status = "disconnected";
      entry.tools = [];
    });
    await Promise.allSettled(promises);
  }

  getToolsForRegistry(): readonly ToolExecutor[] {
    return this.getRegistryTools({ exposedOnly: true });
  }

  getDiscoveredToolsForRegistry(): readonly ToolExecutor[] {
    return this.getRegistryTools({ exposedOnly: false });
  }

  private getRegistryTools(options: { readonly exposedOnly: boolean }): readonly ToolExecutor[] {
    const executors: ToolExecutor[] = [];
    for (const entry of this.entries.values()) {
      this.syncConnectionStatus(entry);
      for (const tool of entry.tools) {
        if (options.exposedOnly && !isToolEnabled(entry.config, tool.name)) {
          continue;
        }
        executors.push(createLazyMcpToolExecutor(
          () => this.connectEntry(entry),
          tool,
          entry.config.serverId,
          createMcpToolDefinition(tool, entry.config.serverId, {
            confirmationMode: entry.config.confirmationMode,
            autoApprovedTools: entry.config.autoApprovedTools,
          }),
        ));
      }
    }
    return executors;
  }

  getServerStatuses(): Readonly<Record<string, McpServerStatus>> {
    const statuses: Record<string, McpServerStatus> = {};
    for (const [serverId, entry] of this.entries) {
      this.syncConnectionStatus(entry);
      statuses[serverId] = entry.status;
    }
    return statuses;
  }

  getServerRuntimeSnapshots(): readonly McpServerRuntimeSnapshot[] {
    return [...this.entries.values()].map((entry) => {
      this.syncConnectionStatus(entry);
      return {
        serverId: entry.config.serverId,
        status: entry.status,
        errorSummary: entry.errorMessage,
        lastConnectedAt: entry.lastConnectedAt,
        toolNames: entry.tools.map((tool) => tool.name),
        ...entry.client.getRuntimeSnapshot(),
      };
    });
  }

  getServerTools(serverId: string): readonly McpToolInfo[] {
    return this.entries.get(serverId)?.tools ?? [];
  }

  async getServerReferences(serverId: string): Promise<McpReferenceInfo | undefined> {
    const entry = this.entries.get(serverId);
    if (entry === undefined) {
      return undefined;
    }
    const client = await this.connectEntry(entry);
    return withAbortTimeout(
      (signal) => client.listReferences({ signal, timeoutMs: this.connectTimeoutMs }),
      this.connectTimeoutMs,
      `MCP server "${entry.config.serverId}" did not list prompts/resources before timeout.`
    );
  }

  private async connectEntry(entry: ServerEntry): Promise<McpClientWrapper> {
    this.syncConnectionStatus(entry);
    if (entry.client.isConnected()) return entry.client;
    if (entry.connecting !== undefined) return entry.connecting;
    let connecting!: Promise<McpClientWrapper>;
    connecting = this.performConnection(entry).finally(() => {
      if (entry.connecting === connecting) entry.connecting = undefined;
    });
    entry.connecting = connecting;
    return connecting;
  }

  private async performConnection(entry: ServerEntry): Promise<McpClientWrapper> {
    entry.status = "connecting";
    try {
      await withAbortTimeout(
        (signal) => entry.client.connect({ signal, timeoutMs: this.connectTimeoutMs }),
        this.connectTimeoutMs,
        `MCP server "${entry.config.serverId}" did not connect before timeout.`
      );
      entry.tools = await withAbortTimeout(
        (signal) => entry.client.listTools({ signal, timeoutMs: this.connectTimeoutMs }),
        this.connectTimeoutMs,
        `MCP server "${entry.config.serverId}" did not list tools before timeout.`
      );
      entry.status = "connected";
      entry.errorMessage = undefined;
      entry.lastConnectedAt = new Date().toISOString();
      return entry.client;
    } catch (error) {
      await entry.client.disconnect().catch(() => undefined);
      entry.status = "error";
      entry.errorMessage = mcpErrorMessage(error instanceof Error ? error.message : "Unknown connection error.");
      throw error;
    }
  }

  private syncConnectionStatus(entry: ServerEntry): void {
    if (entry.status === "connected" && !entry.client.isConnected()) {
      entry.status = "disconnected";
    }
  }
}

function resolveEnvRefs(
  envSecretRefs: readonly string[],
  env?: Readonly<Record<string, string | undefined>>
): Record<string, string> | undefined {
  if (envSecretRefs.length === 0) {
    return undefined;
  }
  if (env === undefined) {
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

function runtimeTransport(server: McpServerSettings): McpClientConfig["transport"] | undefined {
  return server.transport;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const timeoutError = new Error(message);
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function mcpErrorMessage(message: string): string {
  const normalized = message.trim();
  return normalized.length === 0 ? "Unknown connection error." : normalized;
}
