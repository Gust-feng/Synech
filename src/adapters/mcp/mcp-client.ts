import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ensureManagedMcpExecutable, mcpRuntimePathEnvironment } from "./mcp-local-runtime.js";
import {
  assertMcpCatalogWithinLimits,
  DEFAULT_MCP_MAX_TOOL_CATALOG_BYTES,
  DEFAULT_MCP_MAX_TOOL_CATALOG_ITEMS,
  McpCatalogLimitError,
  type McpCatalogLimitUnit,
} from "../../domain/mcp/index.js";

export {
  DEFAULT_MCP_MAX_TOOL_CATALOG_BYTES,
  DEFAULT_MCP_MAX_TOOL_CATALOG_ITEMS,
  McpCatalogLimitError,
};
export type { McpCatalogLimitUnit };

export type McpClientConfig = {
  readonly serverId: string;
  readonly transport: "stdio" | "http";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly httpHeaders?: Readonly<Record<string, string>>;
  readonly managedBinDirectory?: string;
  /** Maximum time without an MCP progress notification before the request is cancelled. */
  readonly requestIdleTimeoutMs?: number;
  /** Optional per-server in-flight tool-call limit. Undefined keeps the SDK's existing behavior. */
  readonly maxConcurrentCalls?: number;
  /** Maximum number of tool definitions accepted from one MCP server. */
  readonly maxToolCatalogItems?: number;
  /** Maximum UTF-8 bytes accepted from one server's serialized tool definitions. */
  readonly maxToolCatalogBytes?: number;
  /** Maximum combined prompts, resources, and templates accepted from one MCP server. */
  readonly maxReferenceCatalogItems?: number;
  /** Maximum combined UTF-8 bytes for one server's serialized reference metadata. */
  readonly maxReferenceCatalogBytes?: number;
};

export type McpClientWrapperOptions = {
  readonly transport?: Transport;
  readonly transportFactory?: () => Transport | Promise<Transport>;
};

export type McpCallOptions = {
  readonly signal?: AbortSignal;
  readonly idleTimeoutMs?: number;
  readonly onProgress?: (progress: McpProgress) => void;
};

export type McpLifecycleRequestOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

export type McpProgress = {
  readonly progress?: number;
  readonly total?: number;
  readonly message?: string;
};

export type McpToolInfo = {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
};

const MAX_MCP_LIST_PAGES = 100;
export const DEFAULT_MCP_MAX_CONCURRENT_CALLS_PER_SERVER = 4;
export const DEFAULT_MCP_MAX_REFERENCE_CATALOG_ITEMS = 1_024;
export const DEFAULT_MCP_MAX_REFERENCE_CATALOG_BYTES = 1024 * 1024;

export type McpToolResult = {
  readonly content: readonly McpContentPart[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
};

export type McpClientHealth = "healthy" | "degraded";

export type McpClientRuntimeSnapshot = {
  readonly health: McpClientHealth;
  readonly activeToolCalls: number;
  readonly queuedToolCalls: number;
  readonly maxConcurrentCalls?: number;
  readonly lastCallFailure?: {
    readonly message: string;
    readonly recordedAt: string;
  };
};

export type McpPromptInfo = {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly required?: boolean;
  }[];
};

export type McpResourceInfo = {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly size?: number;
};

export type McpResourceTemplateInfo = {
  readonly uriTemplate: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
};

export type McpReferenceInfo = {
  readonly prompts: readonly McpPromptInfo[];
  readonly resources: readonly McpResourceInfo[];
  readonly resourceTemplates: readonly McpResourceTemplateInfo[];
};

export type McpContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  | { readonly type: "audio"; readonly data: string; readonly mimeType: string }
  | {
      readonly type: "resource_link";
      readonly uri: string;
      readonly name: string;
      readonly title?: string;
      readonly description?: string;
      readonly mimeType?: string;
      readonly size?: number;
    }
  | {
      readonly type: "resource";
      readonly resource:
        | {
            readonly uri: string;
            readonly mimeType?: string;
            readonly text: string;
          }
        | {
            readonly uri: string;
            readonly mimeType?: string;
            readonly blob: string;
          };
    };

export class McpClientWrapper {
  private client: Client | undefined;
  private connected = false;
  private transport: Transport | undefined;
  private transportCloseLease: McpTransportCloseLease | undefined;
  private readonly pendingTransportCloseLeases = new Set<McpTransportCloseLease>();
  private disconnecting: Promise<void> | undefined;
  private activeToolCalls = 0;
  private readonly pendingToolCalls: Array<PendingToolCallSlot> = [];
  private readonly maxConcurrentCalls: number | undefined;
  private readonly maxToolCatalogItems: number;
  private readonly maxToolCatalogBytes: number;
  private readonly maxReferenceCatalogItems: number;
  private readonly maxReferenceCatalogBytes: number;
  private health: McpClientHealth = "healthy";
  private lastCallFailure?: McpClientRuntimeSnapshot["lastCallFailure"];
  private lifecycleGeneration = 0;

  constructor(
    private readonly config: McpClientConfig,
    private readonly options: McpClientWrapperOptions = {}
  ) {
    this.maxConcurrentCalls = positiveOptionalInteger(config.maxConcurrentCalls);
    this.maxToolCatalogItems = positiveCatalogLimit(
      config.maxToolCatalogItems ?? DEFAULT_MCP_MAX_TOOL_CATALOG_ITEMS,
      "maxToolCatalogItems",
    );
    this.maxToolCatalogBytes = positiveCatalogLimit(
      config.maxToolCatalogBytes ?? DEFAULT_MCP_MAX_TOOL_CATALOG_BYTES,
      "maxToolCatalogBytes",
    );
    this.maxReferenceCatalogItems = positiveCatalogLimit(
      config.maxReferenceCatalogItems ?? DEFAULT_MCP_MAX_REFERENCE_CATALOG_ITEMS,
      "maxReferenceCatalogItems",
    );
    this.maxReferenceCatalogBytes = positiveCatalogLimit(
      config.maxReferenceCatalogBytes ?? DEFAULT_MCP_MAX_REFERENCE_CATALOG_BYTES,
      "maxReferenceCatalogBytes",
    );
  }

  async connect(options: McpLifecycleRequestOptions = {}): Promise<void> {
    if (this.disconnecting !== undefined) {
      await this.disconnecting;
    }
    if (this.connected) {
      return;
    }
    if (this.client !== undefined || this.transport !== undefined ||
        this.transportCloseLease !== undefined || this.pendingTransportCloseLeases.size > 0) {
      throw new Error(
        `MCP client "${this.config.serverId}" still owns resources from a failed disconnect.`,
      );
    }
    const generation = ++this.lifecycleGeneration;
    const transportCloseLease = createMcpTransportCloseLease(
      this.options.transport ?? await (this.options.transportFactory?.() ?? buildTransport(this.config)),
    );
    const transport = transportCloseLease.transport;
    if (generation !== this.lifecycleGeneration) {
      const staleError = staleConnectionAttemptError(this.config.serverId);
      try {
        await transportCloseLease.release();
      } catch (cleanupError) {
        this.pendingTransportCloseLeases.add(transportCloseLease);
        throw new AggregateError(
          [staleError, cleanupError],
          `MCP client "${this.config.serverId}" connection became stale and its transport could not be released.`,
        );
      }
      throw staleError;
    }
    const client = new Client(
      { name: `synech-${this.config.serverId}`, version: "0.1.0" },
      { capabilities: {} }
    );
    this.transport = transport;
    this.transportCloseLease = transportCloseLease;
    this.client = client;
    try {
      await client.connect(transport, lifecycleRequestOptions(options));
      if (
        generation !== this.lifecycleGeneration ||
        this.client !== client ||
        this.transport !== transport
      ) {
        throw staleConnectionAttemptError(this.config.serverId);
      }
      this.connected = true;
      this.health = "healthy";
      this.lastCallFailure = undefined;
    } catch (error) {
      if (this.client === client && this.transport === transport) {
        this.lifecycleGeneration += 1;
        this.connected = false;
        this.rejectPendingToolCalls(new Error(`MCP client "${this.config.serverId}" disconnected.`));
        try {
          await this.closeOwnedResources(client, transport, transportCloseLease);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            `MCP client "${this.config.serverId}" failed to connect and release its transport.`,
          );
        }
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.lifecycleGeneration += 1;
    const client = this.client;
    const transport = this.transport;
    const transportCloseLease = this.transportCloseLease;
    this.connected = false;
    this.rejectPendingToolCalls(new Error(`MCP client "${this.config.serverId}" disconnected.`));
    await this.closeOwnedResources(client, transport, transportCloseLease);
  }

  async listTools(options: McpLifecycleRequestOptions = {}): Promise<readonly McpToolInfo[]> {
    this.assertConnected();
    const catalogBudget = createMcpCatalogBudget(
      "tools",
      this.maxToolCatalogItems,
      this.maxToolCatalogBytes,
    );
    const rawTools = await collectPaginated(
      (cursor) => this.client!.listTools(
        cursor === undefined ? undefined : { cursor },
        lifecycleRequestOptions(options),
      ),
      (page) => page.tools,
      catalogBudget,
    );
    cacheSdkToolMetadata(this.client!, rawTools);
    return rawTools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      outputSchema: tool.outputSchema as Record<string, unknown> | undefined,
      annotations: tool.annotations === undefined ? undefined : {
        title: tool.annotations.title,
        readOnlyHint: tool.annotations.readOnlyHint,
        destructiveHint: tool.annotations.destructiveHint,
        idempotentHint: tool.annotations.idempotentHint,
        openWorldHint: tool.annotations.openWorldHint,
      },
    }));
  }

  async callTool(name: string, args: unknown, options: McpCallOptions = {}): Promise<McpToolResult> {
    this.assertConnected();
    const releaseSlot = await this.acquireToolCallSlot(options.signal);
    try {
      const client = this.client;
      if (client === undefined) {
        throw new Error(`MCP client "${this.config.serverId}" is not connected.`);
      }
      const result = await client.callTool(
        { name, arguments: args as Record<string, unknown> },
        undefined,
        {
          signal: options.signal,
          timeout: options.idleTimeoutMs ?? this.config.requestIdleTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MSEC,
          // A long-running MCP operation may remain valid indefinitely while it reports progress.
          resetTimeoutOnProgress: true,
          // Supplying a handler opts into MCP progress notifications and therefore gives the SDK
          // a progress token whose idle timeout can be refreshed, even when the caller only needs
          // the final tool result.
          onprogress: (progress) => options.onProgress?.({
            ...(typeof progress.progress === "number" ? { progress: progress.progress } : {}),
            ...(typeof progress.total === "number" ? { total: progress.total } : {}),
            ...(typeof progress.message === "string" ? { message: progress.message } : {}),
          }),
        },
      );
      const isError = "isError" in result ? (result.isError as boolean) : undefined;
      const structuredContent = "structuredContent" in result ? result.structuredContent : undefined;
      const rawContent = "content" in result ? (result.content as readonly unknown[]) : [];
      const content = rawContent.map(toMcpContentPart);
      this.health = "healthy";
      this.lastCallFailure = undefined;
      return { content, structuredContent, isError };
    } catch (error) {
      if (options.signal?.aborted !== true) {
        this.recordCallFailure(error);
      }
      throw error;
    } finally {
      releaseSlot();
    }
  }

  getRuntimeSnapshot(): McpClientRuntimeSnapshot {
    return {
      health: this.health,
      activeToolCalls: this.activeToolCalls,
      queuedToolCalls: this.pendingToolCalls.length,
      ...(this.maxConcurrentCalls === undefined ? {} : { maxConcurrentCalls: this.maxConcurrentCalls }),
      ...(this.lastCallFailure === undefined ? {} : { lastCallFailure: { ...this.lastCallFailure } }),
    };
  }

  async listReferences(options: McpLifecycleRequestOptions = {}): Promise<McpReferenceInfo> {
    this.assertConnected();
    // MCP exposes three list methods, but they form one reference catalog and share one budget.
    const catalogBudget = createMcpCatalogBudget(
      "references",
      this.maxReferenceCatalogItems,
      this.maxReferenceCatalogBytes,
    );
    const prompts = await collectPaginated(
      (cursor) => this.client!.listPrompts(
        cursor === undefined ? undefined : { cursor },
        lifecycleRequestOptions(options),
      ),
      (page) => page.prompts,
      catalogBudget,
    ).then((result) => result.map((prompt) => ({
      name: prompt.name,
      title: prompt.title,
      description: prompt.description,
      arguments: prompt.arguments?.map((argument) => ({
        name: argument.name,
        description: argument.description,
        required: argument.required,
      })),
    }))).catch((error: unknown) => referenceListFailure("prompts", error, [] as McpPromptInfo[]));
    const resources = await collectPaginated(
      (cursor) => this.client!.listResources(
        cursor === undefined ? undefined : { cursor },
        lifecycleRequestOptions(options),
      ),
      (page) => page.resources,
      catalogBudget,
    ).then((result) => result.map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      title: resource.title,
      description: resource.description,
      mimeType: resource.mimeType,
      size: resource.size,
    }))).catch((error: unknown) => referenceListFailure("resources", error, [] as McpResourceInfo[]));
    const resourceTemplates = await collectPaginated(
      (cursor) => this.client!.listResourceTemplates(
        cursor === undefined ? undefined : { cursor },
        lifecycleRequestOptions(options),
      ),
      (page) => page.resourceTemplates,
      catalogBudget,
    ).then((result) => result.map((resourceTemplate) => ({
      uriTemplate: resourceTemplate.uriTemplate,
      name: resourceTemplate.name,
      title: resourceTemplate.title,
      description: resourceTemplate.description,
      mimeType: resourceTemplate.mimeType,
    }))).catch((error: unknown) => referenceListFailure(
      "resource templates",
      error,
      [] as McpResourceTemplateInfo[],
    ));
    return { prompts, resources, resourceTemplates };
  }

  isConnected(): boolean {
    return this.connected;
  }

  private assertConnected(): void {
    if (!this.connected || this.client === undefined) {
      throw new Error(`MCP client "${this.config.serverId}" is not connected.`);
    }
  }

  private acquireToolCallSlot(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) return Promise.reject(abortError(signal.reason));
    if (this.maxConcurrentCalls === undefined) {
      return Promise.resolve(() => undefined);
    }
    if (this.activeToolCalls < this.maxConcurrentCalls) {
      this.activeToolCalls += 1;
      return Promise.resolve(() => this.releaseToolCallSlot());
    }
    return new Promise((resolve, reject) => {
      const slot: PendingToolCallSlot = {
        signal,
        resolve: () => {
          this.activeToolCalls += 1;
          resolve(() => this.releaseToolCallSlot());
        },
        reject,
      };
      this.pendingToolCalls.push(slot);
      signal?.addEventListener("abort", slot.onAbort = () => {
        const index = this.pendingToolCalls.indexOf(slot);
        if (index >= 0) this.pendingToolCalls.splice(index, 1);
        reject(abortError(signal.reason));
      }, { once: true });
    });
  }

  private releaseToolCallSlot(): void {
    if (this.maxConcurrentCalls === undefined) return;
    this.activeToolCalls = Math.max(0, this.activeToolCalls - 1);
    while (this.activeToolCalls < this.maxConcurrentCalls) {
      const slot = this.pendingToolCalls.shift();
      if (slot === undefined) return;
      if (slot.signal?.aborted === true) {
        slot.reject(abortError(slot.signal.reason));
        continue;
      }
      if (slot.onAbort !== undefined) slot.signal?.removeEventListener("abort", slot.onAbort);
      slot.resolve();
      return;
    }
  }

  private rejectPendingToolCalls(error: Error): void {
    for (const slot of this.pendingToolCalls.splice(0)) {
      if (slot.onAbort !== undefined) slot.signal?.removeEventListener("abort", slot.onAbort);
      slot.reject(error);
    }
  }

  private recordCallFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.health = "degraded";
    this.lastCallFailure = {
      message: message.length > 500 ? `${message.slice(0, 497)}...` : message,
      recordedAt: new Date().toISOString(),
    };
  }

  private async closeOwnedResources(
    client: Client | undefined,
    transport: Transport | undefined,
    transportCloseLease: McpTransportCloseLease | undefined,
  ): Promise<void> {
    const pendingTransportCloseLeases = [...this.pendingTransportCloseLeases]
      .filter((lease) => lease !== transportCloseLease);
    if (client === undefined && transport === undefined && transportCloseLease === undefined &&
        pendingTransportCloseLeases.length === 0) return;
    if (this.disconnecting !== undefined) return this.disconnecting;

    const releases: Array<{
      readonly release: () => Promise<void>;
      readonly commit: () => void;
    }> = [];
    if (client !== undefined || transport !== undefined || transportCloseLease !== undefined) {
      releases.push({
        release: () => releaseMcpTransport(client, transport, transportCloseLease),
        commit: () => {
          if (this.client === client) this.client = undefined;
          if (this.transport === transport) this.transport = undefined;
          if (this.transportCloseLease === transportCloseLease) this.transportCloseLease = undefined;
        },
      });
    }
    for (const lease of pendingTransportCloseLeases) {
      releases.push({
        release: () => lease.release(),
        commit: () => { this.pendingTransportCloseLeases.delete(lease); },
      });
    }
    const disconnecting = (async () => {
      const results = await Promise.allSettled(releases.map((release) => release.release()));
      const failures: unknown[] = [];
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") releases[index]!.commit();
        else failures.push(result.reason);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, `MCP client "${this.config.serverId}" could not release all transports.`);
      }
    })();
    this.disconnecting = disconnecting;
    try {
      await disconnecting;
    } finally {
      if (this.disconnecting === disconnecting) this.disconnecting = undefined;
    }
  }
}

function lifecycleRequestOptions(options: McpLifecycleRequestOptions): {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
} | undefined {
  if (options.signal === undefined && options.timeoutMs === undefined) {
    return undefined;
  }
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  };
}

async function releaseMcpTransport(
  client: Client | undefined,
  transport: Transport | undefined,
  transportCloseLease: McpTransportCloseLease | undefined,
): Promise<void> {
  if (transportCloseLease !== undefined) return transportCloseLease.release();
  if (transport !== undefined) return transport.close();
  await client?.close();
}

type McpTransportCloseLease = {
  readonly transport: Transport;
  release(): Promise<void>;
};

function createMcpTransportCloseLease(ownedTransport: Transport): McpTransportCloseLease {
  let releasePromise: Promise<void> | undefined;
  let released = false;
  const release = (): Promise<void> => {
    if (released) return Promise.resolve();
    releasePromise ??= Promise.resolve()
      .then(() => ownedTransport.close())
      .then(
        () => { released = true; },
        (error: unknown) => {
          releasePromise = undefined;
          throw error;
        },
      );
    return releasePromise;
  };
  const transport: Transport = {
    start: () => ownedTransport.start(),
    send: (message, options) => ownedTransport.send(message, options),
    async close() {
      // The MCP SDK fires and forgets close() when initialization fails.
      // The wrapper-owned lease remains the awaited, retryable error boundary.
      await release().catch(() => undefined);
    },
    get onclose() { return ownedTransport.onclose; },
    set onclose(listener) { ownedTransport.onclose = listener; },
    get onerror() { return ownedTransport.onerror; },
    set onerror(listener) { ownedTransport.onerror = listener; },
    get onmessage() { return ownedTransport.onmessage; },
    set onmessage(listener) { ownedTransport.onmessage = listener; },
    get sessionId() { return ownedTransport.sessionId; },
    set sessionId(value) { ownedTransport.sessionId = value; },
  };
  if (ownedTransport.setProtocolVersion !== undefined) {
    transport.setProtocolVersion = (version) => ownedTransport.setProtocolVersion?.(version);
  }
  return { transport, release };
}

function staleConnectionAttemptError(serverId: string): Error {
  const error = new Error(`MCP client "${serverId}" connection attempt is no longer current.`);
  error.name = "AbortError";
  return error;
}

function referenceListFailure<T>(kind: string, error: unknown, unsupportedValue: T): T {
  if (isMethodNotFound(error)) {
    return unsupportedValue;
  }
  if (error instanceof McpCatalogLimitError) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`MCP ${kind} listing failed: ${message}`, { cause: error });
}

function isMethodNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { readonly code?: unknown }).code === -32601;
}

type PendingToolCallSlot = {
  readonly signal?: AbortSignal;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  onAbort?: () => void;
};

function positiveOptionalInteger(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("MCP maxConcurrentCalls must be a positive safe integer.");
  }
  return value;
}

function positiveCatalogLimit(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`MCP ${field} must be a positive safe integer.`);
  }
  return value;
}

function abortError(reason: unknown): Error {
  const error = reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "MCP tool call was cancelled.");
  Object.defineProperty(error, "name", { value: "AbortError", configurable: true });
  return error;
}

async function collectPaginated<TItem, TPage extends { readonly nextCursor?: string }>(
  loadPage: (cursor?: string) => Promise<TPage>,
  itemsFromPage: (page: TPage) => readonly TItem[],
  catalogBudget: McpCatalogBudget,
): Promise<readonly TItem[]> {
  const items: TItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_MCP_LIST_PAGES; pageIndex += 1) {
    const page = await loadPage(cursor);
    const pageItems = itemsFromPage(page);
    catalogBudget.consume(pageItems);
    items.push(...pageItems);
    const nextCursor = page.nextCursor;
    if (nextCursor === undefined || nextCursor.length === 0) {
      return items;
    }
    if (seenCursors.has(nextCursor)) {
      throw new Error("MCP list pagination returned a repeated cursor.");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error(`MCP list pagination exceeded ${MAX_MCP_LIST_PAGES} pages.`);
}

type McpCatalogBudget = {
  readonly consume: (items: readonly unknown[]) => void;
};

function createMcpCatalogBudget(
  catalogKind: string,
  maxItems: number,
  maxSerializedBytes: number,
): McpCatalogBudget {
  const collected: unknown[] = [];
  return {
    consume(items) {
      collected.push(...items);
      assertMcpCatalogWithinLimits(catalogKind, collected, maxItems, maxSerializedBytes);
    },
  };
}

function cacheSdkToolMetadata(
  client: Client,
  tools: readonly Awaited<ReturnType<Client["listTools"]>>["tools"][number][]
): void {
  const metadataCache = client as unknown as {
    cacheToolMetadata?: (tools: readonly Awaited<ReturnType<Client["listTools"]>>["tools"][number][]) => void;
  };
  metadataCache.cacheToolMetadata?.(tools);
}

async function buildTransport(config: McpClientConfig): Promise<Transport> {
  if (config.transport === "stdio") {
    if (config.command === undefined) {
      throw new Error(`MCP server "${config.serverId}" requires a command for stdio transport.`);
    }
    const stdioEnv = buildStdioEnvironment(config.env ?? {}, config.managedBinDirectory);
    const command = (await ensureManagedMcpExecutable(config.command, {
      ...process.env,
      ...(stdioEnv ?? {}),
    }, { managedBinDirectory: config.managedBinDirectory })).executable ?? config.command;
    return new StdioClientTransport({
      command,
      args: config.args === undefined ? undefined : [...config.args],
      env: stdioEnv,
      stderr: "ignore",
    });
  }
  if (config.url === undefined) {
    throw new Error(`MCP server "${config.serverId}" requires a url for http transport.`);
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: Object.keys(config.httpHeaders ?? {}).length === 0
      ? undefined
      : { headers: { ...config.httpHeaders } },
  });
}

function buildStdioEnvironment(
  env: Readonly<Record<string, string>>,
  managedBinDirectory: string | undefined,
): Record<string, string> {
  const base = {
    ...getDefaultEnvironment(),
    ...platformPathEnvironment(process.env),
    ...env,
  };
  return {
    ...base,
    ...mcpRuntimePathEnvironment(base, { managedBinDirectory }),
    NODE_USE_SYSTEM_CA: base.NODE_USE_SYSTEM_CA ?? "1",
  };
}

function platformPathEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    const value = env[key];
    if (value !== undefined && value.trim().length > 0) {
      result[key] = value;
    }
  }
  return result;
}

function toMcpContentPart(value: unknown): McpContentPart {
  const raw = mcpContentRecord(value);
  if (raw.type === "text" && typeof raw.text === "string") {
    return { type: "text", text: raw.text };
  }
  if (raw.type === "image" && typeof raw.data === "string" && typeof raw.mimeType === "string") {
    return { type: "image", data: raw.data, mimeType: raw.mimeType };
  }
  if (raw.type === "audio" && typeof raw.data === "string" && typeof raw.mimeType === "string") {
    return { type: "audio", data: raw.data, mimeType: raw.mimeType };
  }
  if (raw.type === "resource_link" && typeof raw.uri === "string" && typeof raw.name === "string") {
    return {
      type: "resource_link",
      uri: raw.uri,
      name: raw.name,
      ...(typeof raw.title === "string" ? { title: raw.title } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(typeof raw.mimeType === "string" ? { mimeType: raw.mimeType } : {}),
      ...(typeof raw.size === "number" && Number.isFinite(raw.size) ? { size: raw.size } : {}),
    };
  }
  if (raw.type === "resource") {
    const resource = mcpContentRecord(raw.resource);
    if (typeof resource.uri === "string" && typeof resource.text === "string") {
      return {
        type: "resource",
        resource: {
          uri: resource.uri,
          ...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
          text: resource.text,
        },
      };
    }
    if (typeof resource.uri === "string" && typeof resource.blob === "string") {
      return {
        type: "resource",
        resource: {
          uri: resource.uri,
          ...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
          blob: resource.blob,
        },
      };
    }
  }
  const type = typeof raw.type === "string" ? raw.type : "missing";
  throw new Error(`Unsupported or malformed MCP tool content block: ${type}.`);
}

function mcpContentRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Unsupported or malformed MCP tool content block: non-object.");
  }
  return value as Readonly<Record<string, unknown>>;
}
