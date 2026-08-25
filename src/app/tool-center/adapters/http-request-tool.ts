import type {
  ToolContinuation,
  ToolExecutor,
  ToolExecutorResult,
  ToolExecutionContext,
  ToolFactValue,
} from "../../../domain/tools/index.js";
import { DEFAULT_MAX_INLINE_TOOL_CONTENT_JSON_CHARS } from "../tool-output-limits.js";
import { ToolOutputStoreError, type ToolOutputStore } from "../tool-output-store.js";

export type HttpRequestMethod = "GET" | "HEAD" | "POST" | "PUT" | "DELETE";

export type HttpRequestFetchLike = (
  url: string,
  init: {
    readonly method: HttpRequestMethod;
    readonly headers?: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  }
) => Promise<HttpRequestFetchResponseLike>;

export type HttpRequestFetchResponseLike = {
  readonly status: number;
  readonly statusText?: string;
  readonly headers?: HeadersLike;
  readonly body?: ReadableStream<Uint8Array> | null;
  readonly text?: () => Promise<string>;
};

export type HeadersLike = {
  forEach?(callback: (value: string, key: string) => void): void;
  entries?(): IterableIterator<[string, string]> | Iterable<[string, string]>;
};

export type HttpRequestToolOptions = {
  readonly fetch?: HttpRequestFetchLike;
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly maxBodyChars?: number;
  readonly outputStore?: ToolOutputStore;
};

export type HttpRequestToolOutput = {
  readonly url: string;
  readonly method: HttpRequestMethod;
  readonly statusCode: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly durationMs: number;
  readonly startChar: number;
  readonly bodyChars: number;
  readonly hasMoreAfter: boolean;
  readonly reachedStartCharCeiling: boolean;
  readonly startCharCeiling: number;
  readonly truncated: boolean;
  readonly continuation?: ToolContinuation;
};

export type HttpRequestIncompleteOutput = {
  readonly url: string;
  readonly method: HttpRequestMethod;
  readonly statusCode: number;
  readonly statusText: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyPreview: string;
  readonly responseBodyComplete: false;
  readonly durationMs: number;
  readonly startChar: number;
  readonly bodyChars: number;
  readonly startCharCeiling: number;
};

export type HttpRequestContinuationOutput = {
  readonly body: string;
  readonly startChar: number;
  readonly bodyChars: number;
  readonly hasMoreAfter: boolean;
  readonly truncated: boolean;
  readonly continuation?: ToolContinuation;
};

export type HttpRequestErrorFacts = {
  readonly url: string;
  readonly method: HttpRequestMethod;
  readonly durationMs: number;
  readonly code?: string;
  readonly statusCode?: number;
  readonly statusText?: string;
  readonly errno?: string | number;
  readonly syscall?: string;
  readonly address?: string;
  readonly port?: number;
  readonly hostname?: string;
  readonly timedOut?: boolean;
  readonly timeoutMs?: number;
};

export class HttpRequestError extends Error {
  readonly facts: HttpRequestErrorFacts;

  constructor(message: string, facts: HttpRequestErrorFacts, cause: unknown) {
    super(message, { cause });
    this.name = "HttpRequestError";
    this.facts = facts;
  }
}

type MutableNetworkFacts = {
  code?: string;
  statusCode?: number;
  statusText?: string;
  errno?: string | number;
  syscall?: string;
  address?: string;
  port?: number;
  hostname?: string;
  timedOut?: boolean;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BODY_CHARS = 128_000;
const MAX_BODY_JSON_CHARS = DEFAULT_MAX_INLINE_TOOL_CONTENT_JSON_CHARS;
const MAX_BODY_START_CHAR = 2_000_000;
const ALLOWED_METHODS = new Set<HttpRequestMethod>(["GET", "HEAD", "POST", "PUT", "DELETE"]);

export function createHttpRequestTool(options: HttpRequestToolOptions = {}): ToolExecutor {
  const maxBodyChars = Math.max(1, Math.floor(options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS));
  return {
    definition: {
      name: "HttpRequest",
      description: "Send a bounded stateless HTTP or HTTPS request and return status, headers, response body, duration, and truncation state.",
      metadata: {
        category: "web",
        riskLevel: "medium",
        operationType: "external-submit",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", minLength: 1, description: "HTTP or HTTPS URL to request." },
          method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "DELETE"], description: "HTTP method. Defaults to GET." },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Optional request headers with string values.",
          },
          body: { description: "Optional string or JSON-serializable request body for POST, PUT, or DELETE." },
          startChar: { type: "integer", minimum: 0, maximum: MAX_BODY_START_CHAR, description: "Zero-based body character offset for continuing a truncated GET response." },
          responseRef: { type: "string", minLength: 1, description: "Opaque GET response reference from continuation.nextInput; do not construct manually." },
          timeoutMs: { type: "integer", minimum: 1, maximum: options.maxTimeoutMs ?? MAX_TIMEOUT_MS, description: `Optional timeout in milliseconds. Defaults to ${options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS}.` },
        },
        oneOf: [
          { required: ["url"], not: { required: ["responseRef"] } },
          {
            required: ["responseRef"],
            not: { anyOf: [
              { required: ["url"] },
              { required: ["method"] },
              { required: ["headers"] },
              { required: ["body"] },
              { required: ["timeoutMs"] },
            ] },
          },
        ],
        allOf: [
          {
            if: { properties: { method: { enum: ["HEAD", "POST", "PUT", "DELETE"] } }, required: ["method"] },
            then: { not: { required: ["startChar"] } },
          },
          {
            if: { properties: { method: { enum: ["GET", "HEAD"] } }, required: ["method"] },
            then: { not: { required: ["body"] } },
          },
          { not: { allOf: [{ required: ["body"] }, { not: { required: ["method"] } }] } },
        ],
        additionalProperties: false,
      },
    },
    execute: (input, context) => executeHttpRequest(input, context, options, maxBodyChars),
  };
}

async function executeHttpRequest(
  input: unknown,
  context: ToolExecutionContext,
  options: HttpRequestToolOptions,
  maxBodyChars: number
): Promise<HttpRequestToolOutput | HttpRequestContinuationOutput | ToolExecutorResult> {
  throwIfAborted(context.abortSignal);
  const record = asRecord(input);
  const responseRef = optionalNonEmptyString(record.responseRef);
  const startChar = boundedBodyStartChar(record.startChar);
  if (responseRef !== undefined) {
    if (options.outputStore === undefined) {
      throw new ToolOutputStoreError(
        "invalid_tool_output_store_configuration",
        "http_request response continuation storage is unavailable.",
      );
    }
    const slice = await options.outputStore.read(responseRef, { startChar, maxChars: maxBodyChars });
    if (slice === undefined) {
      throw new ToolOutputStoreError("tool_output_not_found", "http_request retained response was not found.");
    }
    const continuation = slice.hasMoreAfter
      ? { nextInput: { responseRef, startChar: slice.startChar + slice.textChars } }
      : undefined;
    if (!slice.hasMoreAfter && slice.availability === "live_only") await options.outputStore.release(responseRef);
    return {
      body: slice.content,
      startChar: slice.startChar,
      bodyChars: slice.textChars,
      hasMoreAfter: slice.hasMoreAfter,
      truncated: slice.hasMoreAfter,
      continuation,
    } as HttpRequestContinuationOutput;
  }
  const url = requireHttpUrl(record.url);
  const method = methodFromInput(record.method);
  if (startChar > 0 && method !== "GET") {
    throw new Error("http_request startChar continuation is only supported for GET requests.");
  }
  const timeoutMs = boundedPositiveInteger(
    record.timeoutMs,
    options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.maxTimeoutMs ?? MAX_TIMEOUT_MS
  );
  const headers = headersFromInput(record.headers);
  const body = bodyFromInput(record.body, method, headers);
  const fetchImpl = options.fetch ?? resolveGlobalFetch();
  if (fetchImpl === undefined) {
    throw new Error("http_request requires fetch to be available in this runtime.");
  }

  const startedAt = Date.now();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = context.abortSignal === undefined
    ? timeoutSignal
    : AbortSignal.any([context.abortSignal, timeoutSignal]);
  const timeoutReason = timeoutError(timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: Object.keys(headers).length === 0 ? undefined : headers,
      body,
      signal: requestSignal,
    });
    const bodyResult = method === "HEAD"
      ? { body: "", startChar: 0, bodyChars: 0, hasMoreAfter: false, reachedStartCharCeiling: false, startCharCeiling: MAX_BODY_START_CHAR, truncated: false, fullBody: undefined }
      : await readResponseBody(response, maxBodyChars, startChar, method === "GET" && options.outputStore !== undefined);
    const durationMs = Date.now() - startedAt;
    const statusText = response.statusText ?? "";
    const retained = method === "GET" && bodyResult.fullBody !== undefined && bodyResult.hasMoreAfter && options.outputStore !== undefined
      ? await options.outputStore.retain({
          mediaType: "text/plain",
          content: bodyResult.fullBody,
          sourceToolName: "HttpRequest",
          sourceCallId: context.providerCallId ?? context.invocationId ?? "HttpRequest",
          sourceFactId: context.invocationId,
          ownerId: context.traceId,
        })
      : undefined;
    const snapshotUnavailable = method === "GET" && options.outputStore !== undefined && bodyResult.hasMoreAfter && bodyResult.fullBody === undefined;
    const output: HttpRequestToolOutput = {
      url,
      method,
      statusCode: response.status,
      statusText,
      headers: headersToRecord(response.headers),
      body: bodyResult.body,
      durationMs,
      startChar: bodyResult.startChar,
      bodyChars: bodyResult.bodyChars,
      hasMoreAfter: bodyResult.hasMoreAfter,
      reachedStartCharCeiling: bodyResult.reachedStartCharCeiling,
      startCharCeiling: bodyResult.startCharCeiling,
      truncated: bodyResult.truncated,
      continuation: method !== "GET" || bodyResult.nextStartChar === undefined || snapshotUnavailable
        ? undefined
        : {
            nextInput: {
              ...(retained === undefined ? { url, method, ...(Object.keys(headers).length === 0 ? {} : { headers }) } : { responseRef: retained.ref }),
              startChar: bodyResult.nextStartChar,
              ...(retained === undefined ? { timeoutMs } : {}),
            },
          },
    };
    if (bodyResult.hasMoreAfter && (method !== "GET" || bodyResult.nextStartChar === undefined || snapshotUnavailable)) {
      const continuationLimitReached = method === "GET";
      return {
        kind: "tool_call_result",
        result: {
          providerCallId: context.providerCallId ?? "HttpRequest",
          invocationId: context.invocationId ?? throwMissingInvocation(context, "HttpRequest"),
          toolName: "HttpRequest",
          input: input as ToolFactValue | undefined,
          output: incompleteHttpResponseOutput(output),
          status: "failed",
          error: continuationLimitReached
            ? snapshotUnavailable
              ? "HTTP GET completed, but the response body exceeds the exact snapshot retention range."
              : "HTTP GET completed, but the response body exceeds the supported continuation range."
            : "HTTP request completed, but the response body cannot be fully observed without replaying a side-effecting request.",
          errorDomain: "runtime_error",
          errorFacts: {
            code: continuationLimitReached
              ? snapshotUnavailable ? "http_response_snapshot_limit_reached" : "http_response_continuation_limit_reached"
              : "http_response_continuation_unavailable",
            requestCompleted: true,
            retryable: false,
            ...(continuationLimitReached ? { startCharCeiling: bodyResult.startCharCeiling } : {}),
          },
          durationMs,
        },
      };
    }
    return output;
  } catch (error) {
    if (timeoutSignal.aborted && requestSignal.reason === timeoutSignal.reason) {
      throw normalizeHttpRequestFailure({
        error: timeoutReason,
        url,
        method,
        durationMs: Date.now() - startedAt,
      });
    }
    if (context.abortSignal?.aborted === true) {
      throw new Error("http_request was cancelled.");
    }
    throw normalizeHttpRequestFailure({
      error,
      url,
      method,
      durationMs: Date.now() - startedAt,
    });
  }
}

function incompleteHttpResponseOutput(output: HttpRequestToolOutput): HttpRequestIncompleteOutput {
  return {
    url: output.url,
    method: output.method,
    statusCode: output.statusCode,
    statusText: output.statusText,
    headers: output.headers,
    bodyPreview: output.body,
    responseBodyComplete: false,
    durationMs: output.durationMs,
    startChar: output.startChar,
    bodyChars: output.bodyChars,
    startCharCeiling: output.startCharCeiling,
  };
}

function requireHttpUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("url must be an HTTP or HTTPS URL.");
  }
  const text = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("url must be a valid HTTP or HTTPS URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("http_request only accepts HTTP or HTTPS URLs.");
  }
  return parsed.toString();
}

function methodFromInput(value: unknown): HttpRequestMethod {
  if (value === undefined) {
    return "GET";
  }
  if (typeof value !== "string") {
    throw new Error("method must be one of GET, HEAD, POST, PUT, or DELETE.");
  }
  const method = value.trim().toUpperCase();
  if (!ALLOWED_METHODS.has(method as HttpRequestMethod)) {
    throw new Error("method must be one of GET, HEAD, POST, PUT, or DELETE.");
  }
  return method as HttpRequestMethod;
}

function headersFromInput(value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  const record = asRecordOrUndefined(value);
  if (record === undefined) {
    throw new Error("headers must be an object with string values.");
  }
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(record)) {
    if (typeof headerValue !== "string") {
      throw new Error("headers must be an object with string values.");
    }
    if (key.trim().length > 0) {
      headers[key.trim()] = headerValue;
    }
  }
  return headers;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function bodyFromInput(value: unknown, method: HttpRequestMethod, headers: Record<string, string>): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (method === "GET" || method === "HEAD") {
    throw new Error("GET and HEAD requests do not accept a request body.");
  }
  if (typeof value === "string") {
    return value;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value) ||
    typeof value === "object"
  ) {
    setDefaultContentType(headers);
    return JSON.stringify(value);
  }
  throw new Error("body must be a string or JSON-serializable value.");
}

function setDefaultContentType(headers: Record<string, string>): void {
  const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
  if (!hasContentType) {
    headers["content-type"] = "application/json";
  }
}

async function readResponseBody(
  response: HttpRequestFetchResponseLike,
  maxBodyChars: number,
  startChar: number,
  captureFullBody = false,
): Promise<{
  readonly body: string;
  readonly startChar: number;
  readonly bodyChars: number;
  readonly hasMoreAfter: boolean;
  readonly nextStartChar?: number;
  readonly reachedStartCharCeiling: boolean;
  readonly startCharCeiling: number;
  readonly truncated: boolean;
  readonly fullBody?: string;
}> {
  const readLimit = startChar + maxBodyChars + 1;
  if (response.body !== undefined && response.body !== null) {
    const text = await readStreamBody(
      response.body,
      captureFullBody ? MAX_BODY_START_CHAR + 1 : readLimit,
    );
    return {
      ...bodyWindow(text, startChar, maxBodyChars),
      ...(captureFullBody && text.length <= MAX_BODY_START_CHAR ? { fullBody: text } : {}),
    };
  }
  if (response.text !== undefined) {
    const text = await response.text();
    return {
      ...bodyWindow(text, startChar, maxBodyChars),
      ...(captureFullBody && text.length <= MAX_BODY_START_CHAR ? { fullBody: text } : {}),
    };
  }
  return { body: "", startChar, bodyChars: 0, hasMoreAfter: false, reachedStartCharCeiling: false, startCharCeiling: MAX_BODY_START_CHAR, truncated: false };
}

async function readStreamBody(
  stream: ReadableStream<Uint8Array>,
  maxReadChars: number
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        break;
      }
      text += decoder.decode(chunk.value, { stream: true });
      if (text.length > maxReadChars) {
        text = text.slice(0, maxReadChars);
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

function bodyWindow(
  text: string,
  startChar: number,
  maxBodyChars: number
): {
  readonly body: string;
  readonly startChar: number;
  readonly bodyChars: number;
  readonly hasMoreAfter: boolean;
  readonly nextStartChar?: number;
  readonly reachedStartCharCeiling: boolean;
  readonly startCharCeiling: number;
  readonly truncated: boolean;
} {
  const requestedEndChar = Math.min(text.length, startChar + maxBodyChars);
  const endChar = transportSafeBodyEnd(text, startChar, requestedEndChar);
  const body = text.slice(startChar, endChar);
  const hasMoreAfter = text.length > endChar;
  const rawNextStartChar = hasMoreAfter ? startChar + body.length : undefined;
  const nextStartChar = rawNextStartChar !== undefined && rawNextStartChar > startChar && rawNextStartChar <= MAX_BODY_START_CHAR
    ? rawNextStartChar
    : undefined;
  return {
    body,
    startChar,
    bodyChars: body.length,
    hasMoreAfter,
    nextStartChar,
    reachedStartCharCeiling: hasMoreAfter && rawNextStartChar !== undefined && rawNextStartChar > MAX_BODY_START_CHAR,
    startCharCeiling: MAX_BODY_START_CHAR,
    truncated: hasMoreAfter,
  };
}

function transportSafeBodyEnd(text: string, startChar: number, requestedEndChar: number): number {
  if (startChar >= requestedEndChar) {
    return requestedEndChar;
  }
  if (JSON.stringify(text.slice(startChar, requestedEndChar)).length <= MAX_BODY_JSON_CHARS) {
    return requestedEndChar;
  }
  let low = startChar;
  let high = requestedEndChar;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(text.slice(startChar, middle)).length <= MAX_BODY_JSON_CHARS) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

function headersToRecord(headers: HeadersLike | undefined): Readonly<Record<string, string>> {
  if (headers === undefined) {
    return {};
  }
  const result: Record<string, string> = {};
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      result[key.toLowerCase()] = value;
    });
    return result;
  }
  if (typeof headers.entries === "function") {
    for (const [key, value] of headers.entries()) {
      result[key.toLowerCase()] = value;
    }
  }
  return result;
}

function boundedPositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Math.min(Math.max(1, Math.floor(fallback)), Math.max(1, Math.floor(max)));
  }
  return Math.min(Math.floor(value), Math.max(1, Math.floor(max)));
}

function boundedBodyStartChar(value: unknown): number {
  return Math.min(MAX_BODY_START_CHAR, Math.max(0, positiveInteger(value) ?? 0));
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function resolveGlobalFetch(): HttpRequestFetchLike | undefined {
  const fetchImpl = (globalThis as { fetch?: HttpRequestFetchLike }).fetch;
  return typeof fetchImpl === "function" ? fetchImpl : undefined;
}

export function createHttpTimeoutCause(label: string, timeoutMs: number): Error & {
  readonly code: "ETIMEDOUT";
  readonly timedOut: true;
  readonly timeoutMs: number;
} {
  return Object.assign(new Error(`${label} timed out after ${timeoutMs}ms.`), {
    code: "ETIMEDOUT" as const,
    timedOut: true as const,
    timeoutMs,
  });
}

function timeoutError(timeoutMs: number): Error {
  return createHttpTimeoutCause("http_request", timeoutMs);
}

export function normalizeHttpRequestFailure(input: {
  readonly error: unknown;
  readonly url: string;
  readonly method: HttpRequestMethod;
  readonly durationMs: number;
}): HttpRequestError {
  const causeFacts = networkFailureFacts(input.error);
  const facts = createHttpRequestErrorFacts({
    url: input.url,
    method: input.method,
    durationMs: input.durationMs,
    ...causeFacts,
  });
  return new HttpRequestError(
    `http_request failed: ${describeFailure(input.error, facts)}.`,
    facts,
    input.error
  );
}

export function createHttpRequestErrorFacts(facts: HttpRequestErrorFacts): HttpRequestErrorFacts {
  return compactFacts(facts);
}

export function createHttpStatusErrorFacts(input: {
  readonly url: string;
  readonly method: HttpRequestMethod;
  readonly durationMs: number;
  readonly statusCode: number;
  readonly statusText?: string;
}): HttpRequestErrorFacts {
  return createHttpRequestErrorFacts({
    url: input.url,
    method: input.method,
    durationMs: input.durationMs,
    statusCode: input.statusCode,
    statusText: input.statusText,
  });
}

function networkFailureFacts(error: unknown): MutableNetworkFacts {
  const facts: MutableNetworkFacts = {};
  for (const value of errorCauseChain(error)) {
    const record = asRecordOrUndefined(value);
    if (record === undefined) {
      continue;
    }
    facts.code ??= stringOrUndefined(record.code);
    facts.statusCode ??= numberOrUndefined(record.statusCode);
    facts.statusText ??= stringOrUndefined(record.statusText);
    facts.errno ??= stringOrNumberOrUndefined(record.errno);
    facts.syscall ??= stringOrUndefined(record.syscall);
    facts.address ??= stringOrUndefined(record.address);
    facts.port ??= numberOrUndefined(record.port);
    facts.hostname ??= stringOrUndefined(record.hostname);
    facts.timedOut ??= booleanOrUndefined(record.timedOut);
    facts.timeoutMs ??= numberOrUndefined(record.timeoutMs);
  }
  return facts;
}

function errorCauseChain(error: unknown): readonly unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = asRecordOrUndefined(current)?.cause;
  }
  return chain;
}

function describeFailure(error: unknown, facts: HttpRequestErrorFacts): string {
  const messages = failureMessages(error);
  const message = messages.length === 0 ? undefined : messages.join("; cause=");
  const parts = [
    facts.code === undefined ? undefined : `code=${facts.code}`,
    facts.statusCode === undefined ? undefined : `statusCode=${facts.statusCode}`,
    facts.statusText === undefined ? undefined : `statusText=${facts.statusText}`,
    facts.errno === undefined ? undefined : `errno=${String(facts.errno)}`,
    facts.syscall === undefined ? undefined : `syscall=${facts.syscall}`,
    facts.hostname === undefined ? undefined : `hostname=${facts.hostname}`,
    facts.address === undefined ? undefined : `address=${facts.address}`,
    facts.port === undefined ? undefined : `port=${facts.port}`,
    facts.timedOut === true ? "timedOut=true" : undefined,
    facts.timeoutMs === undefined ? undefined : `timeoutMs=${facts.timeoutMs}`,
    `durationMs=${facts.durationMs}`,
  ].filter(isString);
  const factsText = parts.join(", ");
  return message === undefined ? factsText : `${message} (${factsText})`;
}

function failureMessages(error: unknown): readonly string[] {
  const messages: string[] = [];
  for (const value of errorCauseChain(error)) {
    const message = value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : undefined;
    const text = stringOrUndefined(message);
    if (text !== undefined && !messages.includes(text)) {
      messages.push(text);
    }
  }
  return messages;
}

function compactFacts(facts: HttpRequestErrorFacts): HttpRequestErrorFacts {
  return {
    url: facts.url,
    method: facts.method,
    durationMs: facts.durationMs,
    code: stringOrUndefined(facts.code),
    statusCode: numberOrUndefined(facts.statusCode),
    statusText: stringOrUndefined(facts.statusText),
    errno: facts.errno,
    syscall: stringOrUndefined(facts.syscall),
    address: stringOrUndefined(facts.address),
    port: numberOrUndefined(facts.port),
    hostname: stringOrUndefined(facts.hostname),
    timedOut: facts.timedOut === true ? true : undefined,
    timeoutMs: numberOrUndefined(facts.timeoutMs),
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("http_request was cancelled.");
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return asRecordOrUndefined(value) ?? {};
}

function asRecordOrUndefined(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

function stringOrNumberOrUndefined(value: unknown): string | number | undefined {
  return typeof value === "number" ? value : stringOrUndefined(value);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return value === true ? true : value === false ? false : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function throwMissingInvocation(context: ToolExecutionContext, toolName: string): never {
  throw new Error(
    `Tool adapter for ${toolName} cannot construct a ToolCallResult without an upstream-bound invocationId.`
    + ` providerCallId=${context.providerCallId ?? "undefined"}.`,
  );
}
