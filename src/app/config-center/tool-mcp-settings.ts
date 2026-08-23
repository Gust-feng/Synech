import type {
  LocalSettings,
  McpCachedReferenceInfo,
  McpCachedToolInfo,
  McpConfirmationMode,
  McpServerSettings,
  McpToolExposureMode,
  ToolStateSettings,
} from "../../domain/config/index.js";
import { cloneToolInputSchema, cloneToolJsonSchema } from "../../domain/tools/index.js";
import {
  ConfigSchemaValidationError,
  asRecord,
  normalizeRequiredConfigString,
  optionalString,
  safeConfigId,
} from "./settings-utils.js";

export function sanitizeMcpArgs(args: readonly string[]): readonly string[] {
  const sanitized: string[] = [];
  let nextArgIsSecret = false;
  for (const raw of args) {
    const arg = String(raw).trim();
    if (arg.length === 0) {
      continue;
    }
    const sensitiveKeyValue = /(?:api[_-]?key|token|secret|password|passwd|bearer)\s*[=:]/i.test(arg);
    const sensitiveFlag = /^--?(?:api[_-]?key|token|secret|password|passwd|bearer)$/i.test(arg);
    const likelySecretValue = /^(?:Bearer\s+|sk-[A-Za-z0-9_-]+|tvly-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.)/.test(arg);
    if (nextArgIsSecret || sensitiveKeyValue || sensitiveFlag || likelySecretValue) {
      sanitized.push("[secret-ref-required]");
    } else {
      sanitized.push(arg);
    }
    nextArgIsSecret = sensitiveFlag;
  }
  return sanitized;
}

export function parseMcpCommandLine(value: string): {
  readonly command?: string;
  readonly args: readonly string[];
} {
  const tokens = splitCommandLine(value);
  if (tokens.length === 0) {
    return { args: [] };
  }
  return {
    command: tokens[0],
    args: sanitizeMcpArgs(tokens.slice(1)),
  };
}

export function parseToolStates(value: unknown, updatedAt: string): LocalSettings["toolStates"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item): ToolStateSettings | undefined => {
      const record = asRecord(item);
      const name = optionalString(record.name);
      if (name === undefined) {
        return undefined;
      }
      return {
        name,
        enabled: record.enabled !== false,
        updatedAt: optionalString(record.updatedAt) ?? updatedAt,
      };
    })
    .filter((item): item is ToolStateSettings => item !== undefined);
}

export function parseMcpServers(value: unknown, updatedAt: string): LocalSettings["mcpServers"] {
  if (!Array.isArray(value)) {
    return [];
  }
  const servers: McpServerSettings[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const serverId = safeConfigId(optionalString(record.serverId) ?? "");
    const transport = parseTransport(record.transport);
    if (serverId.length === 0) {
      continue;
    }
    const enabledTools = Array.isArray(record.enabledTools)
      ? [...new Set(record.enabledTools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0).map((tool) => tool.trim()))]
      : [];
    const autoApprovedTools = Array.isArray(record.autoApprovedTools)
      ? [...new Set(record.autoApprovedTools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0).map((tool) => tool.trim()))]
      : [];
    const cachedTools = parseMcpCachedTools(record.cachedTools);
    const cachedReferences = parseMcpCachedReferences(record.cachedReferences);
    const referencesCachedAt =
      optionalString(record.referencesCachedAt) ??
      optionalString(record.lastConnectedAt) ??
      (Object.keys(asRecord(record.cachedReferences)).length > 0 ? updatedAt : undefined);
    servers.push({
      serverId,
      label: optionalString(record.label) ?? serverId,
      description: optionalString(record.description),
      transport,
      command: optionalString(record.command),
      args: sanitizeMcpArgs(Array.isArray(record.args) ? record.args.filter((arg): arg is string => typeof arg === "string") : []),
      url: optionalString(record.url),
      envSecretRefs: Array.isArray(record.envSecretRefs)
        ? record.envSecretRefs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
        : [],
      headerSecretRefs: Array.isArray(record.headerSecretRefs)
        ? record.headerSecretRefs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0)
        : [],
      bearerTokenSecretRef: optionalString(record.bearerTokenSecretRef),
      apiKeySecretRef: optionalString(record.apiKeySecretRef),
      apiKeyHeaderName: optionalString(record.apiKeyHeaderName),
      confirmationMode: parseConfirmationMode(record.confirmationMode),
      toolExposureMode: parseToolExposureMode(record.toolExposureMode, enabledTools),
      enabledTools,
      autoApprovedTools,
      enabled: typeof record.enabled === "boolean" ? record.enabled : false,
      lastConnectedAt: optionalString(record.lastConnectedAt),
      lastError: optionalString(record.lastError),
      ...(cachedTools.length > 0 ? {
        cachedTools,
        toolsCachedAt: optionalString(record.toolsCachedAt) ?? optionalString(record.lastConnectedAt) ?? updatedAt,
      } : {}),
      ...(referencesCachedAt !== undefined ? {
        cachedReferences,
        referencesCachedAt,
      } : {}),
      updatedAt: optionalString(record.updatedAt) ?? updatedAt,
    });
  }
  return servers;
}

export function normalizeToolStates(states: readonly ToolStateSettings[], now: string): readonly ToolStateSettings[] {
  return states.map((state) => ({
    name: normalizeRequiredConfigString(state.name, "tool name"),
    enabled: state.enabled,
    updatedAt: optionalString(state.updatedAt) ?? now,
  }));
}

export function normalizeMcpServers(servers: readonly McpServerSettings[], now: string): readonly McpServerSettings[] {
  return servers.map((server) => {
    const cachedTools = normalizeMcpCachedTools(server.cachedTools ?? []);
    const cachedReferences = normalizeMcpCachedReferences(server.cachedReferences);
    const referencesCachedAt = optionalString(server.referencesCachedAt);
    return {
      serverId: normalizeConfigId(server.serverId),
      label: optionalString(server.label) ?? server.serverId,
      description: optionalString(server.description),
      transport: parseTransport(server.transport),
      command: optionalString(server.command),
      args: sanitizeMcpArgs(server.args ?? []),
      url: optionalString(server.url),
      envSecretRefs: server.envSecretRefs.map((ref) => optionalString(ref)).filter((ref): ref is string => ref !== undefined),
      headerSecretRefs: uniqueStrings(server.headerSecretRefs),
      bearerTokenSecretRef: optionalString(server.bearerTokenSecretRef),
      apiKeySecretRef: optionalString(server.apiKeySecretRef),
      apiKeyHeaderName: optionalString(server.apiKeyHeaderName),
      confirmationMode: parseConfirmationMode(server.confirmationMode),
      toolExposureMode: parseToolExposureMode(server.toolExposureMode, server.enabledTools),
      enabledTools: uniqueStrings(server.enabledTools),
      autoApprovedTools: uniqueStrings(server.autoApprovedTools),
      enabled: server.enabled,
      lastConnectedAt: optionalString(server.lastConnectedAt),
      lastError: optionalString(server.lastError),
      ...(cachedTools.length > 0 ? {
        cachedTools,
        toolsCachedAt: optionalString(server.toolsCachedAt) ?? optionalString(server.lastConnectedAt) ?? now,
      } : {}),
      ...(server.cachedReferences !== undefined || referencesCachedAt !== undefined ? {
        cachedReferences,
        referencesCachedAt: referencesCachedAt ?? optionalString(server.lastConnectedAt) ?? now,
      } : {}),
      updatedAt: optionalString(server.updatedAt) ?? now,
    };
  });
}

function normalizeConfigId(value: string): string {
  const normalized = safeConfigId(value);
  if (normalized.length === 0) {
    throw new ConfigSchemaValidationError("Profile id must contain letters, numbers, underscore, or dash.");
  }
  return normalized;
}

function parseConfirmationMode(value: unknown): McpConfirmationMode {
  if (value === "unsafe_only" || value === "never") {
    return value;
  }
  return "always";
}

function parseToolExposureMode(value: unknown, enabledTools: readonly string[] = []): McpToolExposureMode {
  if (value === "all" || value === "selected" || value === "none") {
    return value;
  }
  return enabledTools.length > 0 ? "selected" : "none";
}

function parseTransport(value: unknown): McpServerSettings["transport"] {
  return value === "http" || value === "streamableHttp" || value === "sse"
    ? "http"
    : "stdio";
}

function uniqueStrings(values: readonly string[] | undefined): readonly string[] {
  return [...new Set((values ?? []).map((value) => optionalString(value)).filter((value): value is string => value !== undefined))];
}

function parseMcpCachedTools(value: unknown): readonly McpCachedToolInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const parsed: McpCachedToolInfo[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const name = optionalString(record.name);
    if (name === undefined) {
      continue;
    }
    try {
      parsed.push({
        name,
        title: optionalString(record.title),
        description: optionalString(record.description),
        inputSchema: cloneToolInputSchema(record.inputSchema),
        outputSchema: record.outputSchema === undefined
          ? undefined
          : cloneToolJsonSchema(record.outputSchema),
        annotations: parseMcpToolAnnotations(record.annotations),
      });
    } catch {
      // A cached catalog is advisory. Ignore an invalid entry instead of
      // publishing a schema whose constraints were only partially retained.
    }
  }
  return normalizeMcpCachedTools(parsed);
}

function normalizeMcpCachedTools(value: readonly McpCachedToolInfo[]): readonly McpCachedToolInfo[] {
  const tools: McpCachedToolInfo[] = [];
  const seen = new Set<string>();
  for (const tool of value) {
    const name = optionalString(tool.name);
    if (name === undefined || seen.has(name)) {
      continue;
    }
    seen.add(name);
    tools.push({
      name,
      title: optionalString(tool.title),
      description: optionalString(tool.description),
      inputSchema: cloneToolInputSchema(tool.inputSchema),
      outputSchema: tool.outputSchema === undefined
        ? undefined
        : cloneToolJsonSchema(tool.outputSchema),
      annotations: parseMcpToolAnnotations(tool.annotations),
    });
  }
  return tools;
}

function parseMcpCachedReferences(value: unknown): McpCachedReferenceInfo {
  const record = asRecord(value);
  return normalizeMcpCachedReferences({
    prompts: Array.isArray(record.prompts) ? record.prompts.map(parseMcpCachedPrompt).filter(isDefined) : [],
    resources: Array.isArray(record.resources) ? record.resources.map(parseMcpCachedResource).filter(isDefined) : [],
    resourceTemplates: Array.isArray(record.resourceTemplates)
      ? record.resourceTemplates.map(parseMcpCachedResourceTemplate).filter(isDefined)
      : [],
  });
}

function normalizeMcpCachedReferences(value: McpCachedReferenceInfo | undefined): McpCachedReferenceInfo {
  return {
    prompts: uniqueByName((value?.prompts ?? []).map((prompt) => ({
      name: optionalString(prompt.name) ?? "",
      title: optionalString(prompt.title),
      description: optionalString(prompt.description),
      arguments: Array.isArray(prompt.arguments)
        ? prompt.arguments.map(parseMcpPromptArgument).filter(isDefined)
        : undefined,
    })).filter((prompt) => prompt.name.length > 0)),
    resources: uniqueByName((value?.resources ?? []).map((resource) => ({
      uri: optionalString(resource.uri) ?? "",
      name: optionalString(resource.name) ?? "",
      title: optionalString(resource.title),
      description: optionalString(resource.description),
      mimeType: optionalString(resource.mimeType),
      size: typeof resource.size === "number" && Number.isFinite(resource.size) ? Math.max(0, Math.floor(resource.size)) : undefined,
    })).filter((resource) => resource.uri.length > 0 && resource.name.length > 0)),
    resourceTemplates: uniqueByName((value?.resourceTemplates ?? []).map((template) => ({
      uriTemplate: optionalString(template.uriTemplate) ?? "",
      name: optionalString(template.name) ?? "",
      title: optionalString(template.title),
      description: optionalString(template.description),
      mimeType: optionalString(template.mimeType),
    })).filter((template) => template.uriTemplate.length > 0 && template.name.length > 0)),
  };
}

function parseMcpCachedPrompt(value: unknown): McpCachedReferenceInfo["prompts"][number] | undefined {
  const record = asRecord(value);
  const name = optionalString(record.name);
  if (name === undefined) {
    return undefined;
  }
  return {
    name,
    title: optionalString(record.title),
    description: optionalString(record.description),
    arguments: Array.isArray(record.arguments)
      ? record.arguments.map(parseMcpPromptArgument).filter(isDefined)
      : undefined,
  };
}

function parseMcpPromptArgument(value: unknown): NonNullable<McpCachedReferenceInfo["prompts"][number]["arguments"]>[number] | undefined {
  const record = asRecord(value);
  const name = optionalString(record.name);
  if (name === undefined) {
    return undefined;
  }
  return {
    name,
    description: optionalString(record.description),
    required: typeof record.required === "boolean" ? record.required : undefined,
  };
}

function parseMcpCachedResource(value: unknown): McpCachedReferenceInfo["resources"][number] | undefined {
  const record = asRecord(value);
  const uri = optionalString(record.uri);
  const name = optionalString(record.name);
  if (uri === undefined || name === undefined) {
    return undefined;
  }
  return {
    uri,
    name,
    title: optionalString(record.title),
    description: optionalString(record.description),
    mimeType: optionalString(record.mimeType),
    size: typeof record.size === "number" && Number.isFinite(record.size) ? Math.max(0, Math.floor(record.size)) : undefined,
  };
}

function parseMcpCachedResourceTemplate(value: unknown): McpCachedReferenceInfo["resourceTemplates"][number] | undefined {
  const record = asRecord(value);
  const uriTemplate = optionalString(record.uriTemplate);
  const name = optionalString(record.name);
  if (uriTemplate === undefined || name === undefined) {
    return undefined;
  }
  return {
    uriTemplate,
    name,
    title: optionalString(record.title),
    description: optionalString(record.description),
    mimeType: optionalString(record.mimeType),
  };
}

function uniqueByName<T extends { readonly name: string }>(values: readonly T[]): readonly T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const value of values) {
    if (seen.has(value.name)) {
      continue;
    }
    seen.add(value.name);
    output.push(value);
  }
  return output;
}

function parseMcpToolAnnotations(value: unknown): McpCachedToolInfo["annotations"] {
  const record = asRecord(value);
  const annotations = {
    title: optionalString(record.title),
    readOnlyHint: typeof record.readOnlyHint === "boolean" ? record.readOnlyHint : undefined,
    destructiveHint: typeof record.destructiveHint === "boolean" ? record.destructiveHint : undefined,
    openWorldHint: typeof record.openWorldHint === "boolean" ? record.openWorldHint : undefined,
  };
  return Object.values(annotations).some((item) => item !== undefined) ? annotations : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function splitCommandLine(value: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  const input = value.trim();
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (char === "\\") {
      const next = input[index + 1];
      if (next === quote || next === "\\") {
        current += next;
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}
