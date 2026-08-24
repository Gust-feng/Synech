import type {
  LocalDevSecretStore,
  LocalSettings,
  McpCachedReferenceInfo,
  McpCachedToolInfo,
  McpServerSecretValueInput,
  McpServerSettings,
  SanitizedMcpServerSecretMetadata,
  UpsertMcpServerInput,
} from "../../domain/config/index.js";
import { ConfigCenterValidationError } from "./config-center-error.js";
import {
  normalizeLocalSettings,
  normalizeOptionalString,
  normalizeProfileId,
  normalizeRequiredConfigString,
  parseMcpCommandLine,
  sanitizeMcpArgs,
} from "./settings-schema.js";

type McpSettingsChange = {
  readonly settings: LocalSettings;
  readonly result: readonly McpServerSettings[];
};

export type UpdateMcpServerConnectionStateInput = {
  readonly serverId: string;
  readonly connectedAt?: string;
  readonly errorSummary?: string;
  readonly cachedTools?: readonly McpCachedToolInfo[];
  readonly cachedReferences?: McpCachedReferenceInfo;
};

export function upsertMcpServer(
  current: LocalSettings,
  input: UpsertMcpServerInput,
  now: string,
): McpSettingsChange {
  const serverId = normalizeProfileId(input.serverId);
  const existing = (current.mcpServers ?? []).find((server) => server.serverId === serverId);
  const parsedCommandLine = input.commandLine === undefined ? undefined : parseMcpCommandLine(input.commandLine);
  const draftServer: McpServerSettings = {
    serverId,
    label: normalizeOptionalString(input.label) ?? existing?.label ?? serverId,
    description: input.description === undefined ? existing?.description : normalizeOptionalString(input.description),
    transport: input.transport ?? existing?.transport ?? "stdio",
    command: parsedCommandLine?.command ?? normalizeOptionalString(input.command) ?? existing?.command,
    args: parsedCommandLine?.args ?? (input.args === undefined ? existing?.args ?? [] : sanitizeMcpArgs(input.args)),
    url: normalizeOptionalString(input.url) ?? existing?.url,
    envSecretRefs: input.envSecretRefs === undefined
      ? existing?.envSecretRefs ?? []
      : normalizedStringList(input.envSecretRefs),
    headerSecretRefs: input.clearMcpAuth === true
      ? []
      : input.headerSecretRefs === undefined
        ? existing?.headerSecretRefs ?? []
        : normalizedStringList(input.headerSecretRefs),
    bearerTokenSecretRef: input.clearMcpAuth === true
      ? undefined
      : normalizeOptionalString(input.bearerTokenSecretRef) ?? existing?.bearerTokenSecretRef,
    apiKeySecretRef: input.clearMcpAuth === true
      ? undefined
      : normalizeOptionalString(input.apiKeySecretRef) ?? existing?.apiKeySecretRef,
    apiKeyHeaderName: input.clearMcpAuth === true
      ? undefined
      : normalizeOptionalString(input.apiKeyHeaderName) ?? existing?.apiKeyHeaderName,
    confirmationMode: input.confirmationMode ?? existing?.confirmationMode ?? "never",
    toolExposureMode: input.toolExposureMode ?? existing?.toolExposureMode ?? "none",
    enabledTools: input.enabledTools === undefined
      ? existing?.enabledTools ?? []
      : uniqueNormalizedStrings(input.enabledTools),
    autoApprovedTools: input.autoApprovedTools === undefined
      ? existing?.autoApprovedTools ?? []
      : uniqueNormalizedStrings(input.autoApprovedTools),
    enabled: input.enabled ?? existing?.enabled ?? false,
    updatedAt: now,
  };
  const connectionChanged = existing !== undefined && mcpConnectionConfigChanged(existing, draftServer);
  const cachedTools = connectionChanged ? undefined : existing?.cachedTools;
  const cachedReferences = connectionChanged ? undefined : existing?.cachedReferences;
  const nextServer: McpServerSettings = {
    ...draftServer,
    lastConnectedAt: connectionChanged ? undefined : existing?.lastConnectedAt,
    lastError: connectionChanged ? undefined : existing?.lastError,
    ...(cachedTools !== undefined && cachedTools.length > 0
      ? { cachedTools, toolsCachedAt: existing?.toolsCachedAt }
      : {}),
    ...(cachedReferences !== undefined
      ? { cachedReferences, referencesCachedAt: existing?.referencesCachedAt }
      : {}),
  };
  return mcpSettingsChange(current, upsertMcpServerInOrder(current.mcpServers ?? [], nextServer), now);
}

export function deleteMcpServer(
  current: LocalSettings,
  serverId: string,
  now: string,
): McpSettingsChange {
  const normalized = normalizeProfileId(serverId);
  const existing = current.mcpServers ?? [];
  const nextServers = existing.filter((server) => server.serverId !== normalized);
  if (nextServers.length === existing.length) {
    throw new ConfigCenterValidationError(`MCP server not found: ${normalized}`);
  }
  return mcpSettingsChange(current, nextServers, now);
}

export function updateMcpServerConnectionState(
  current: LocalSettings,
  input: UpdateMcpServerConnectionStateInput,
  now: string,
): McpSettingsChange {
  const serverId = normalizeProfileId(input.serverId);
  const existing = (current.mcpServers ?? []).find((server) => server.serverId === serverId);
  if (existing === undefined) {
    throw new ConfigCenterValidationError(`MCP server not found: ${serverId}`);
  }
  const nextServer: McpServerSettings = {
    ...existing,
    lastConnectedAt: input.connectedAt ?? existing.lastConnectedAt,
    lastError: input.errorSummary,
    ...(input.cachedTools !== undefined ? { cachedTools: input.cachedTools, toolsCachedAt: now } : {}),
    ...(input.cachedReferences !== undefined
      ? { cachedReferences: input.cachedReferences, referencesCachedAt: now }
      : {}),
    updatedAt: now,
  };
  return mcpSettingsChange(
    current,
    upsertMcpServerInOrder(current.mcpServers ?? [], nextServer),
    now,
  );
}

export async function writeMcpServerSecretValue(
  settings: LocalSettings,
  secretStore: LocalDevSecretStore,
  input: McpServerSecretValueInput,
): Promise<SanitizedMcpServerSecretMetadata> {
  const serverId = normalizeProfileId(input.serverId);
  const server = (settings.mcpServers ?? []).find((item) => item.serverId === serverId);
  if (server === undefined) {
    throw new ConfigCenterValidationError(`MCP server not found: ${serverId}`);
  }
  const secretRef = normalizeRequiredConfigString(input.secretRef, "MCP secret ref");
  if (!mcpServerOwnsSecretRef(server, secretRef)) {
    throw new ConfigCenterValidationError(`MCP secret ref is not declared for server: ${serverId}`);
  }
  const value = normalizeRequiredConfigString(input.value, "MCP secret value");
  const metadata = await secretStore.writeSecret(secretRef, value);
  return { secretRef, ...metadata };
}

export function collectMcpRuntimeSecretRefs(
  servers: readonly Pick<
    McpServerSettings,
    "envSecretRefs" | "headerSecretRefs" | "bearerTokenSecretRef" | "apiKeySecretRef"
  >[],
): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const server of servers) {
    for (const ref of server.envSecretRefs) refs.add(ref);
    for (const ref of server.headerSecretRefs ?? []) {
      const parsed = parseHeaderSecretRef(ref);
      if (parsed !== undefined) refs.add(parsed.secretRef);
    }
    if (server.bearerTokenSecretRef !== undefined) refs.add(server.bearerTokenSecretRef);
    if (server.apiKeySecretRef !== undefined) refs.add(server.apiKeySecretRef);
  }
  return refs;
}

function mcpSettingsChange(
  current: LocalSettings,
  mcpServers: readonly McpServerSettings[],
  now: string,
): McpSettingsChange {
  const settings = normalizeLocalSettings({
    ...current,
    version: 1,
    mcpServers,
    updatedAt: now,
  });
  return { settings, result: settings.mcpServers ?? [] };
}

function normalizedStringList(values: readonly string[]): readonly string[] {
  return values
    .map((value) => normalizeOptionalString(value))
    .filter((value): value is string => value !== undefined);
}

function uniqueNormalizedStrings(values: readonly string[]): readonly string[] {
  return [...new Set(normalizedStringList(values))];
}

function mcpConnectionConfigChanged(left: McpServerSettings, right: McpServerSettings): boolean {
  return left.transport !== right.transport ||
    left.command !== right.command ||
    !sameStringList(left.args ?? [], right.args ?? []) ||
    left.url !== right.url ||
    !sameStringList(left.envSecretRefs, right.envSecretRefs) ||
    !sameStringList(left.headerSecretRefs ?? [], right.headerSecretRefs ?? []) ||
    left.bearerTokenSecretRef !== right.bearerTokenSecretRef ||
    left.apiKeySecretRef !== right.apiKeySecretRef ||
    left.apiKeyHeaderName !== right.apiKeyHeaderName;
}

function upsertMcpServerInOrder(
  servers: readonly McpServerSettings[],
  nextServer: McpServerSettings,
): readonly McpServerSettings[] {
  const existingIndex = servers.findIndex((server) => server.serverId === nextServer.serverId);
  if (existingIndex < 0) return [...servers, nextServer];
  return servers.map((server, index) => index === existingIndex ? nextServer : server);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function mcpServerOwnsSecretRef(server: McpServerSettings, secretRef: string): boolean {
  return server.envSecretRefs.includes(secretRef) ||
    (server.headerSecretRefs ?? []).some((ref) => parseHeaderSecretRef(ref)?.secretRef === secretRef || ref === secretRef) ||
    server.bearerTokenSecretRef === secretRef ||
    server.apiKeySecretRef === secretRef;
}

function parseHeaderSecretRef(
  value: string,
): { readonly headerName: string; readonly secretRef: string } | undefined {
  const separator = value.indexOf("=");
  if (separator <= 0) return undefined;
  const headerName = value.slice(0, separator).trim();
  const secretRef = value.slice(separator + 1).trim();
  return headerName.length === 0 || secretRef.length === 0 ? undefined : { headerName, secretRef };
}
