import { isDeepStrictEqual } from "node:util";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutor,
  ToolExecutorResult,
  ToolFactValue,
} from "../../domain/tools/index.js";
import {
  normalizeToolFactValue,
  withToolModelAttachments,
} from "../../domain/tools/index.js";
import type { ModelInputAttachment } from "../../domain/intelligence/index.js";
import {
  createMcpToolDefinition,
  DEFAULT_MCP_TOOL_CONFIRMATION_STRATEGY,
  type McpToolConfirmationStrategy,
} from "../../domain/mcp/index.js";
import type { McpClientWrapper, McpContentPart, McpProgress, McpToolInfo, McpToolResult } from "./mcp-client.js";
const MAX_MCP_MODEL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_MCP_MODEL_ATTACHMENTS = 16;
const MAX_MCP_MODEL_ATTACHMENT_TOTAL_BYTES = 32 * 1024 * 1024;

export function createMcpToolExecutor(
  client: McpClientWrapper,
  tool: McpToolInfo,
  serverId: string,
  confirmationStrategy: McpToolConfirmationStrategy = DEFAULT_MCP_TOOL_CONFIRMATION_STRATEGY
): ToolExecutor {
  const definition = createMcpToolDefinition(tool, serverId, confirmationStrategy);
  return {
    definition,
    async execute(input: unknown, context: ToolExecutionContext): Promise<unknown | ToolExecutorResult> {
      return executeMcpToolForExecutor(client, tool, serverId, definition.name, input, context);
    },
  };
}

export function createLazyMcpToolExecutor(
  getClient: () => Promise<McpClientWrapper>,
  tool: McpToolInfo,
  serverId: string,
  definition: ToolDefinition,
): ToolExecutor {
  return {
    definition,
    async execute(input: unknown, context: ToolExecutionContext): Promise<unknown | ToolExecutorResult> {
      const client = await waitForMcpClient(getClient(), context.abortSignal);
      return executeMcpToolForExecutor(client, tool, serverId, definition.name, input, context);
    },
  };
}

/**
 * A lazy client may be shared by several tool calls. Abort only this caller's
 * wait; the provider owns the connection attempt and closes it during cleanup.
 */
async function waitForMcpClient(
  clientPromise: Promise<McpClientWrapper>,
  signal: AbortSignal | undefined,
): Promise<McpClientWrapper> {
  if (signal === undefined) {
    return clientPromise;
  }
  if (signal.aborted) {
    throw mcpAbortError(signal.reason);
  }
  return await new Promise<McpClientWrapper>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(mcpAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    clientPromise.then(
      (client) => {
        cleanup();
        resolve(client);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function mcpAbortError(reason: unknown): Error {
  const error = reason instanceof Error
    ? reason
    : new Error(typeof reason === "string" ? reason : "MCP tool call was cancelled.");
  Object.defineProperty(error, "name", { value: "AbortError", configurable: true });
  return error;
}

export function createCachedMcpToolExecutor(
  tool: McpToolInfo,
  serverId: string,
  confirmationStrategy: McpToolConfirmationStrategy = DEFAULT_MCP_TOOL_CONFIRMATION_STRATEGY
): ToolExecutor {
  const definition = createMcpToolDefinition(tool, serverId, confirmationStrategy);
  return {
    definition,
    async execute(): Promise<unknown> {
      throw new Error(`MCP tool "${definition.name}" is cached for catalog use and requires a live MCP connection to execute.`);
    },
  };
}

async function executeMcpToolForExecutor(
  client: McpClientWrapper,
  tool: Pick<McpToolInfo, "name">,
  serverId: string,
  canonicalName: string,
  input: unknown,
  context: ToolExecutionContext
): Promise<McpToolOutput | ToolExecutorResult> {
  const startedAt = Date.now();
  let mcpResult: McpToolResult;
  try {
    mcpResult = await client.callTool(tool.name, input, {
      signal: context.abortSignal,
      onProgress: (progress) => reportMcpProgress(context, progress),
    });
  } catch (error) {
    if (context.abortSignal?.aborted === true) {
      throw error;
    }
    const timeoutFacts = mcpRequestTimeoutFacts(error);
    if (timeoutFacts === undefined) {
      throw error;
    }
    return {
      kind: "tool_call_result",
      result: {
        providerCallId: context.providerCallId ?? canonicalName,
        invocationId: context.invocationId ?? throwMissingInvocation(context, canonicalName),
        toolName: canonicalName,
        input: input as ToolFactValue | undefined,
        output: {
          provider: serverId,
          tool: tool.name,
          reason: "mcp_request_idle_timeout",
        },
        status: "failed",
        error: `MCP tool ${canonicalName} stopped making progress before returning a result.`,
        errorDomain: "runtime_error",
        errorFacts: {
          code: "mcp_request_idle_timeout",
          serverId,
          mcpToolName: tool.name,
          sourceExecutionStatus: "unknown",
          doNotBlindlyRetry: true,
          ...timeoutFacts,
        },
        durationMs: Date.now() - startedAt,
      },
    };
  }
  let output: McpToolOutput;
  try {
    output = buildToolOutput(mcpResult);
  } catch (error) {
    return mcpPostExecutionDeliveryFailure({
      error,
      result: mcpResult,
      input,
      context,
      serverId,
      toolName: tool.name,
      canonicalName,
      startedAt,
    });
  }
  if (mcpResult.isError !== true) {
    return output;
  }
  return {
    kind: "tool_call_result",
    result: {
      providerCallId: context.providerCallId ?? canonicalName,
      invocationId: context.invocationId ?? throwMissingInvocation(context, canonicalName),
      toolName: canonicalName,
      input: input as ToolFactValue | undefined,
      output: output as ToolFactValue,
      status: "failed",
      error: `MCP tool ${canonicalName} reported an error.`,
      errorDomain: "tool_error",
      errorFacts: {
        code: "mcp_tool_error",
        serverId,
        mcpToolName: tool.name,
      },
      durationMs: Date.now() - startedAt,
    },
  };
}

function reportMcpProgress(context: ToolExecutionContext, progress: McpProgress): void {
  try {
    context.reportProgress?.({
      kind: "mcp_progress",
      ...(progress.progress === undefined ? {} : { progress: progress.progress }),
      ...(progress.total === undefined ? {} : { total: progress.total }),
      ...(progress.message === undefined ? {} : { message: progress.message }),
    });
  } catch {
    // Progress is live-only observation and cannot alter the MCP tool outcome.
  }
}

function mcpRequestTimeoutFacts(error: unknown): Readonly<Record<string, string | number>> | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as { readonly code?: unknown; readonly data?: unknown };
  if (record.code !== -32001) return undefined;
  const data = typeof record.data === "object" && record.data !== null
    ? record.data as Record<string, unknown>
    : {};
  return {
    ...(typeof data.timeout === "number" ? { timeoutMs: data.timeout } : {}),
    ...(typeof data.maxTotalTimeout === "number" ? { maxTotalTimeoutMs: data.maxTotalTimeout } : {}),
  };
}

export type McpToolOutput = {
  readonly content: readonly McpToolOutputContentPart[];
  readonly structuredContent?: McpStructuredContent;
};

type McpStructuredContent = {
  readonly [key: string]: ToolFactValue | undefined;
};

export type McpToolOutputContentPart =
  | {
      readonly type: "text";
      readonly text: string;
    }
  | {
      readonly type: "image";
      readonly mimeType: string;
      readonly byteLength: number;
      readonly modelInput: "attached";
      readonly modelAttachmentIndex: number;
    }
  | {
      readonly type: "audio";
      readonly mimeType: string;
      readonly filename: string;
      readonly byteLength: number;
      readonly modelInput: "audio_attachment";
      readonly modelAttachmentIndex: number;
    }
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
            readonly byteLength: number;
            readonly modelInput: "attached";
            readonly modelAttachmentIndex: number;
          }
        | {
            readonly uri: string;
            readonly mimeType?: string;
            readonly filename: string;
            readonly byteLength: number;
            readonly modelInput: "file_attachment";
            readonly modelAttachmentIndex: number;
          };
    };

function buildToolOutput(result: {
  readonly content: readonly McpContentPart[];
  readonly structuredContent?: unknown;
}): McpToolOutput {
  const structuredContent = result.structuredContent === undefined
    ? undefined
    : normalizeMcpStructuredContent(result.structuredContent);
  const content: McpToolOutputContentPart[] = [];
  const protocolContent = structuredContent === undefined
    ? result.content
    : result.content.filter((part) => !isExactStructuredContentMirror(part, structuredContent));
  const modelAttachments: ModelInputAttachment[] = [];
  let modelAttachmentBytes = 0;
  const reserveAttachment = (byteLength: number, mimeType: string) => {
    assertMcpModelAttachmentSize(byteLength, mimeType);
    const nextCount = modelAttachments.length + 1;
    if (nextCount > MAX_MCP_MODEL_ATTACHMENTS) {
      throw mcpModelAttachmentBudgetError(
        "mcp_model_attachment_count_exceeded",
        `MCP tool result has more than ${MAX_MCP_MODEL_ATTACHMENTS} model attachments.`,
        { attachmentCount: nextCount, maxAttachments: MAX_MCP_MODEL_ATTACHMENTS },
      );
    }
    const nextBytes = modelAttachmentBytes + byteLength;
    if (nextBytes > MAX_MCP_MODEL_ATTACHMENT_TOTAL_BYTES) {
      throw mcpModelAttachmentBudgetError(
        "mcp_model_attachment_total_bytes_exceeded",
        `MCP tool result model attachments exceed the ${MAX_MCP_MODEL_ATTACHMENT_TOTAL_BYTES} byte aggregate limit.`,
        {
          attachmentCount: nextCount,
          totalBytes: nextBytes,
          maxTotalBytes: MAX_MCP_MODEL_ATTACHMENT_TOTAL_BYTES,
        },
      );
    }
    modelAttachmentBytes = nextBytes;
  };
  const attachImage = (data: string, mimeType: string) => {
    const byteLength = approximateBase64Bytes(data);
    reserveAttachment(byteLength, mimeType);
    const modelAttachmentIndex = modelAttachments.length;
    modelAttachments.push({
      kind: "image",
      source: { kind: "data", mimeType, data },
      byteLength,
    });
    return { byteLength, modelAttachmentIndex };
  };
  const attachFile = (
    data: string,
    mimeType: string,
    filename: string,
    inputRef: string
  ) => {
    const byteLength = approximateBase64Bytes(data);
    reserveAttachment(byteLength, mimeType);
    const modelAttachmentIndex = modelAttachments.length;
    modelAttachments.push({
      kind: "file",
      source: { kind: "data", mimeType, data },
      filename,
      inputRef,
      byteLength,
    });
    return { byteLength, modelAttachmentIndex };
  };
  const attachAudio = (
    data: string,
    mimeType: string,
    filename: string,
    inputRef: string,
  ) => {
    const byteLength = approximateBase64Bytes(data);
    reserveAttachment(byteLength, mimeType);
    const modelAttachmentIndex = modelAttachments.length;
    modelAttachments.push({
      kind: "audio",
      source: { kind: "data", mimeType, data },
      filename,
      inputRef,
      byteLength,
    });
    return { byteLength, modelAttachmentIndex };
  };
  for (const [contentIndex, part] of protocolContent.entries()) {
    switch (part.type) {
      case "text":
        content.push({ type: "text", text: part.text });
        break;
      case "image": {
        const attachment = attachImage(part.data, part.mimeType);
        content.push({
          type: "image",
          mimeType: part.mimeType,
          ...attachment,
          modelInput: "attached",
        });
        break;
      }
      case "audio": {
        const filename = `mcp-audio-${contentIndex + 1}${extensionForMimeType(part.mimeType)}`;
        const attachment = attachAudio(
          part.data,
          part.mimeType,
          filename,
          `mcp-content:audio:${contentIndex}`
        );
        content.push({
          type: "audio",
          mimeType: part.mimeType,
          filename,
          ...attachment,
          modelInput: "audio_attachment",
        });
        break;
      }
      case "resource_link":
        content.push({
          type: "resource_link",
          uri: part.uri,
          name: part.name,
          ...(part.title === undefined ? {} : { title: part.title }),
          ...(part.description === undefined ? {} : { description: part.description }),
          ...(part.mimeType === undefined ? {} : { mimeType: part.mimeType }),
          ...(part.size === undefined ? {} : { size: part.size }),
        });
        break;
      case "resource":
        if ("text" in part.resource) {
          content.push({
            type: "resource",
            resource: {
              uri: part.resource.uri,
              ...(part.resource.mimeType === undefined ? {} : { mimeType: part.resource.mimeType }),
              text: part.resource.text,
            },
          });
          break;
        }
        if (part.resource.mimeType?.toLowerCase().startsWith("image/") === true) {
          const attachment = attachImage(part.resource.blob, part.resource.mimeType);
          content.push({
            type: "resource",
            resource: {
              uri: part.resource.uri,
              mimeType: part.resource.mimeType,
              ...attachment,
              modelInput: "attached",
            },
          });
          break;
        }
        const mimeType = part.resource.mimeType ?? "application/octet-stream";
        const filename = filenameForResource(
          part.resource.uri,
          mimeType,
          contentIndex
        );
        const attachment = attachFile(
          part.resource.blob,
          mimeType,
          filename,
          part.resource.uri
        );
        content.push({
          type: "resource",
          resource: {
            uri: part.resource.uri,
            ...(part.resource.mimeType === undefined ? {} : { mimeType: part.resource.mimeType }),
            filename,
            ...attachment,
            modelInput: "file_attachment",
          },
        });
        break;
      default:
        throw unsupportedMcpContentPart(part);
    }
  }
  const output: McpToolOutput = {
    content,
    ...(structuredContent === undefined
      ? {}
      : { structuredContent }),
  };
  return withToolModelAttachments(output, modelAttachments);
}

function normalizeMcpStructuredContent(value: unknown): McpStructuredContent {
  const normalized = normalizeToolFactValue(value);
  if (!isMcpStructuredContent(normalized)) {
    throw Object.assign(
      new Error("MCP structuredContent must be a JSON object."),
      {
        errorDomain: "runtime_error",
        code: "mcp_structured_content_not_object",
        facts: {
          code: "mcp_structured_content_not_object",
          expected: "object",
          actual: normalized === null ? "null" : Array.isArray(normalized) ? "array" : typeof normalized,
        },
      },
    );
  }
  return normalized;
}

function isMcpStructuredContent(value: ToolFactValue | undefined): value is McpStructuredContent {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function isExactStructuredContentMirror(part: McpContentPart, structuredContent: unknown): boolean {
  if (part.type !== "text") {
    return false;
  }
  try {
    return isDeepStrictEqual(JSON.parse(part.text), structuredContent);
  } catch {
    return false;
  }
}

function unsupportedMcpContentPart(value: never): Error {
  return new Error(`Unsupported MCP content part: ${String((value as { readonly type?: unknown }).type ?? "unknown")}.`);
}

function approximateBase64Bytes(value: string): number {
  const clean = value.replace(/\s+/g, "");
  if (clean.length === 0) {
    return 0;
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function assertMcpModelAttachmentSize(byteLength: number, mimeType: string): void {
  if (byteLength <= MAX_MCP_MODEL_ATTACHMENT_BYTES) {
    return;
  }
  throw Object.assign(
    new Error(
      `MCP model attachment ${mimeType} has ${byteLength} bytes; the in-request limit is ${MAX_MCP_MODEL_ATTACHMENT_BYTES}.`,
    ),
    {
      errorDomain: "runtime_error",
      code: "mcp_model_attachment_too_large",
      facts: {
        mimeType,
        byteLength,
        maxBytes: MAX_MCP_MODEL_ATTACHMENT_BYTES,
      },
    },
  );
}

function mcpModelAttachmentBudgetError(
  code: "mcp_model_attachment_count_exceeded" | "mcp_model_attachment_total_bytes_exceeded",
  message: string,
  facts: Readonly<Record<string, number>>,
): Error {
  return Object.assign(new Error(message), {
    errorDomain: "runtime_error",
    code,
    facts,
  });
}

function mcpPostExecutionDeliveryFailure(input: {
  readonly error: unknown;
  readonly result: {
    readonly content: readonly McpContentPart[];
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
  };
  readonly input: unknown;
  readonly context: ToolExecutionContext;
  readonly serverId: string;
  readonly toolName: string;
  readonly canonicalName: string;
  readonly startedAt: number;
}): ToolExecutorResult {
  const errorRecord = plainRecord(input.error);
  const code = typeof errorRecord.code === "string" && errorRecord.code.length > 0
    ? errorRecord.code
    : "mcp_result_delivery_failed";
  const message = input.error instanceof Error
    ? input.error.message
    : "MCP tool result could not be converted into model-visible facts.";
  const sourceExecutionStatus = input.result.isError === true ? "failed" : "completed";
  const causeFacts = normalizedRecordFact(errorRecord.facts);
  const output = mcpDeliveryFailureOutput({
    result: input.result,
    code,
    message,
    sourceExecutionStatus,
  });
  return {
    kind: "tool_call_result",
    result: {
      providerCallId: input.context.providerCallId ?? input.canonicalName,
      invocationId: input.context.invocationId ?? throwMissingInvocation(input.context, input.canonicalName),
      toolName: input.canonicalName,
      input: normalizeFactWithoutThrowing(input.input),
      output,
      status: "failed",
      error: `MCP tool ${input.canonicalName} returned, but its result could not be delivered: ${message}`,
      errorDomain: "runtime_error",
      errorFacts: {
        ...(causeFacts ?? {}),
        code,
        phase: "mcp_result_delivery",
        serverId: input.serverId,
        mcpToolName: input.toolName,
        mcpIsError: input.result.isError === true,
        sourceExecutionStatus,
        doNotBlindlyRetry: true,
      },
      durationMs: Date.now() - input.startedAt,
    },
  };
}

function mcpDeliveryFailureOutput(input: {
  readonly result: {
    readonly content: readonly McpContentPart[];
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
  };
  readonly code: string;
  readonly message: string;
  readonly sourceExecutionStatus: "completed" | "failed";
}): ToolFactValue {
  const structuredContent = normalizeFactWithoutThrowing(input.result.structuredContent);
  return {
    content: input.result.content.map(mcpDeliveryFailureContentPart),
    ...(structuredContent === undefined ? {} : { structuredContent }),
    resultDelivery: {
      status: "failed",
      code: input.code,
      message: input.message,
      mcpIsError: input.result.isError === true,
      sourceExecutionStatus: input.sourceExecutionStatus,
      doNotBlindlyRetry: true,
    },
  };
}

function mcpDeliveryFailureContentPart(part: McpContentPart, index: number): ToolFactValue {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return {
        type: "image",
        mimeType: part.mimeType,
        byteLength: approximateBase64Bytes(part.data),
        modelInput: "not_delivered",
      };
    case "audio":
      return {
        type: "audio",
        mimeType: part.mimeType,
        filename: `mcp-audio-${index + 1}${extensionForMimeType(part.mimeType)}`,
        byteLength: approximateBase64Bytes(part.data),
        modelInput: "not_delivered",
      };
    case "resource_link":
      return {
        type: "resource_link",
        uri: part.uri,
        name: part.name,
        ...(part.title === undefined ? {} : { title: part.title }),
        ...(part.description === undefined ? {} : { description: part.description }),
        ...(part.mimeType === undefined ? {} : { mimeType: part.mimeType }),
        ...(part.size === undefined ? {} : { size: part.size }),
      };
    case "resource":
      return "text" in part.resource
        ? {
            type: "resource",
            resource: {
              uri: part.resource.uri,
              ...(part.resource.mimeType === undefined ? {} : { mimeType: part.resource.mimeType }),
              text: part.resource.text,
            },
          }
        : {
            type: "resource",
            resource: {
              uri: part.resource.uri,
              ...(part.resource.mimeType === undefined ? {} : { mimeType: part.resource.mimeType }),
              byteLength: approximateBase64Bytes(part.resource.blob),
              modelInput: "not_delivered",
            },
          };
    default:
      return {
        type: String((part as { readonly type?: unknown }).type ?? "unknown"),
        modelInput: "not_delivered",
      };
  }
}

function normalizedRecordFact(value: unknown): Readonly<Record<string, ToolFactValue | undefined>> | undefined {
  const normalized = normalizeFactWithoutThrowing(value);
  return typeof normalized === "object" && normalized !== null && !Array.isArray(normalized)
    ? normalized as Readonly<Record<string, ToolFactValue | undefined>>
    : undefined;
}

function normalizeFactWithoutThrowing(value: unknown): ToolFactValue | undefined {
  try {
    return normalizeToolFactValue(value);
  } catch {
    return undefined;
  }
}

function filenameForResource(uri: string, mimeType: string, contentIndex: number): string {
  try {
    const parsed = new URL(uri);
    const candidate = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (candidate !== undefined && candidate.length > 0) {
      return decodeURIComponent(candidate);
    }
  } catch {
  }
  return `mcp-resource-${contentIndex + 1}${extensionForMimeType(mimeType)}`;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase().split(";", 1)[0]?.trim()) {
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/mpeg":
      return ".mp3";
    case "audio/mp4":
      return ".m4a";
    case "audio/ogg":
      return ".ogg";
    case "audio/webm":
      return ".webm";
    case "application/pdf":
      return ".pdf";
    case "application/json":
      return ".json";
    case "text/plain":
      return ".txt";
    default:
      return ".bin";
  }
}

function throwMissingInvocation(context: ToolExecutionContext, canonicalName: string): never {
  throw new Error(
    `MCP tool adapter cannot construct a ToolCallResult for ${canonicalName}: ToolExecutionContext is missing an invocationId.`
    + ` providerCallId=${context.providerCallId ?? "undefined"}; the owning feature must pass the bound id.`,
  );
}
