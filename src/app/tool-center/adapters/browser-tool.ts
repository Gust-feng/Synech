import { asRecord } from "../../../kernel/values/index.js";
import type { ToolExecutor } from "../../../domain/tools/index.js";
import { ToolOutputStoreError, type ToolOutputStore } from "../tool-output-store.js";

export type BrowserAutomation = {
  snapshot(input: {
    readonly url: string;
    readonly waitMs: number;
    readonly abortSignal?: AbortSignal;
  }): Promise<BrowserSnapshotResult>;
};

export type BrowserSnapshotResult = {
  readonly url: string;
  readonly title?: string;
  readonly text?: string;
};

export type BrowserToolOptions = {
  readonly automation?: BrowserAutomation;
  readonly outputStore?: ToolOutputStore;
};

const DEFAULT_BROWSER_TEXT_CHARS = 64_000;
const MAX_BROWSER_TEXT_CHARS = 128_000;

export function createBrowserSnapshotTool(options: BrowserToolOptions = {}): ToolExecutor {
  const automation = options.automation ?? createPlaywrightBrowserAutomation();
  return {
    definition: {
      name: "WebFetch",
      description: "Read rendered text from an HTTP(S) page in an isolated browser session.",
      metadata: {
        category: "web",
        riskLevel: "medium",
        operationType: "read-only",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", minLength: 1, description: "HTTP or HTTPS URL to open." },
          waitMs: { type: "integer", minimum: 1, maximum: 5_000, description: "Optional wait time after page load, max 5000ms." },
          maxTextChars: { type: "integer", minimum: 1, maximum: MAX_BROWSER_TEXT_CHARS, description: "Optional maximum text characters to return." },
          startChar: { type: "integer", minimum: 0, description: "Zero-based body text offset for continuing a truncated snapshot." },
          snapshotRef: { type: "string", minLength: 1, description: "Opaque snapshot reference from continuation.nextInput; do not construct manually." },
        },
        oneOf: [
          { required: ["url"], not: { required: ["snapshotRef"] } },
          { required: ["snapshotRef"], not: { anyOf: [{ required: ["url"] }, { required: ["waitMs"] }] } },
        ],
        additionalProperties: false,
      },
    },
    execute: async (input, context) => {
      throwIfAborted(context.abortSignal);
      const record = asRecord(input);
      const waitMs = Math.min(5_000, positiveInteger(record.waitMs) ?? 500);
      const maxTextChars = Math.min(MAX_BROWSER_TEXT_CHARS, positiveInteger(record.maxTextChars) ?? DEFAULT_BROWSER_TEXT_CHARS);
      const startChar = startCharFromInput(record.startChar);
      const snapshotRef = optionalString(record.snapshotRef);
      if (snapshotRef !== undefined) {
        if (options.outputStore === undefined) {
          throw new ToolOutputStoreError(
            "invalid_tool_output_store_configuration",
            "web_fetch continuation storage is unavailable.",
          );
        }
        const slice = await options.outputStore.read(snapshotRef, { startChar, maxChars: maxTextChars });
        if (slice === undefined) {
          throw new ToolOutputStoreError("tool_output_not_found", "web_fetch retained snapshot was not found.");
        }
        const continuation = slice.hasMoreAfter
          ? { nextInput: { snapshotRef, maxTextChars, startChar: slice.startChar + slice.textChars } }
          : undefined;
        if (!slice.hasMoreAfter && slice.availability === "live_only") await options.outputStore.release(snapshotRef);
        return {
          text: slice.content,
          startChar: slice.startChar,
          textChars: slice.textChars,
          totalTextChars: slice.totalChars,
          hasMoreAfter: slice.hasMoreAfter,
          truncated: slice.hasMoreAfter,
          continuation,
        };
      }
      const url = requireHttpUrl(record.url);
      const snapshot = await automation.snapshot({
        url,
        waitMs,
        abortSignal: context.abortSignal,
      }).catch((error: unknown) => {
        if (context.abortSignal?.aborted === true || (error instanceof Error && error.name === "AbortError")) {
          throw error;
        }
        throw new BrowserSnapshotError("browser_navigation_failed", "web_fetch could not navigate and capture the page.", error);
      });
      const fullText = snapshot.text ?? "";
      const text = fullText.slice(startChar, safeWindowEnd(startChar, maxTextChars));
      const hasMoreAfter = fullText.length > startChar + text.length;
      const nextStartChar = hasMoreAfter ? startChar + text.length : undefined;
      const retained = hasMoreAfter && options.outputStore !== undefined
        ? await options.outputStore.retain({
            mediaType: "text/plain",
            content: fullText,
            sourceToolName: "WebFetch",
            sourceCallId: context.toolCallId ?? "WebFetch",
            sourceFactId: context.toolCallId,
            ownerId: context.traceId,
          })
        : undefined;
      return {
        refId: `browser:page:${safeRefToken(snapshot.url)}`,
        url: snapshot.url,
        title: snapshot.title,
        text,
        startChar,
        textChars: text.length,
        totalTextChars: fullText.length,
        hasMoreAfter,
        truncated: hasMoreAfter,
        continuation: nextStartChar === undefined
          ? undefined
          : retained === undefined
            ? { nextInput: { url: snapshot.url, waitMs, maxTextChars, startChar: nextStartChar } }
            : { nextInput: { snapshotRef: retained.ref, maxTextChars, startChar: nextStartChar } },
      };
    },
  };
}

class BrowserSnapshotError extends Error {
  constructor(readonly code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BrowserSnapshotError";
  }
}

function createPlaywrightBrowserAutomation(): BrowserAutomation {
  return {
    async snapshot(input) {
      const playwright = await loadPlaywright();
      const browser = await playwright.chromium.launch({ headless: true });
      const abort = input.abortSignal;
      try {
        throwIfAborted(abort);
        const page = await browser.newPage();
        const abortPromise = new Promise<never>((_, reject) => {
          abort?.addEventListener("abort", () => reject(new Error("Browser tool cancelled.")), { once: true });
        });
        await Promise.race([
          page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 15_000 }),
          abortPromise,
        ]);
        if (input.waitMs > 0) {
          await Promise.race([page.waitForTimeout(input.waitMs), abortPromise]);
        }
        const [url, title, text] = await Promise.all([
          page.url(),
          page.title().catch(() => undefined),
          page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""),
        ]);
        return {
          url,
          title,
          text,
        };
      } finally {
        await browser.close().catch(() => undefined);
      }
    },
  };
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<PlaywrightModule>;
    return await dynamicImport("playwright");
  } catch {
    throw new Error("web_fetch requires Playwright to be installed and available in this workspace.");
  }
}

type PlaywrightModule = {
  readonly chromium: {
    launch(options: { readonly headless: boolean }): Promise<{
      newPage(): Promise<{
        goto(url: string, options: { readonly waitUntil: "domcontentloaded"; readonly timeout: number }): Promise<unknown>;
        waitForTimeout(ms: number): Promise<void>;
        title(): Promise<string>;
        url(): string;
        locator(selector: string): {
          innerText(options: { readonly timeout: number }): Promise<string>;
        };
      }>;
      close(): Promise<void>;
    }>;
  };
};

function requireHttpUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("url must be an HTTP or HTTPS URL.");
  }
  const text = value.trim();
  const parsed = new URL(text);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("web_fetch only accepts HTTP or HTTPS URLs.");
  }
  return parsed.toString();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("Browser tool cancelled.");
  }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function startCharFromInput(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("web_fetch startChar must be a non-negative safe integer.");
  }
  return value;
}

function safeWindowEnd(startChar: number, maxTextChars: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, startChar + maxTextChars);
}


function safeRefToken(value: string): string {
  const token = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return token.length === 0 ? "page" : token;
}
