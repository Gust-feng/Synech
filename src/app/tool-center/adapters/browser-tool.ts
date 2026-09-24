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

/**
 * 「没有浏览器能力」的原因文案（既有文案，逐字保留）：它已经出现在能力目录快照与
 * run 级注册表的 disabledReason 里，改字会让两处宿主登记值对不上。
 */
const WEB_FETCH_UNAVAILABLE_REASON = "Playwright is not installed in this workspace.";

/**
 * 宿主声明的浏览器能力（进程级，唯一 owner 是 Panel 组合根）。
 *
 * 浏览器能力属于宿主进程：桌面端由 Electron 自带 Chromium 提供，浏览器模式下没有
 * 任何可用实现。但工具注册表在宿主之后按需创建（能力目录快照、每个 run 的 run 级
 * 注册表），无法逐个把实例传下去，因此「本进程有没有浏览器能力」这个事实由组合根
 * 登记一次，注册表按需读取。
 *
 * 显式传入的 `automation` 仍然优先——注入接缝没有改变，这里只是补上宿主默认值。
 */
let hostBrowserAutomation: BrowserAutomation | undefined;

export function declareHostBrowserAutomation(automation: BrowserAutomation | undefined): void {
  hostBrowserAutomation = automation;
}

export function resolveHostBrowserAutomation(): BrowserAutomation | undefined {
  return hostBrowserAutomation;
}

/**
 * 「本进程有没有网页抓取能力」的唯一判定：WebFetch 工具的能力可用性只看这里。
 *
 * 判定链与 `resolveBrowserAutomation` 的执行回退链逐条对应：显式注入的自动化 →
 * 宿主登记的自动化（桌面端为 Electron 自带 Chromium）→ Playwright 是否可解析。
 * 这个事实只能有一处实现：调用方若各算一份，就可能注册出一个「看起来能用、一调就
 * 失败」的工具（正是本轮要收口的问题）。
 *
 * `playwrightAvailable` 是调用方已解析好的宿主登记值（能力目录快照 / run 级注册表
 * 从冻结目录读到的结论）：传了就按它算，不再重复探测。
 */
export function resolveWebFetchAvailability(input: {
  readonly browserAutomation?: BrowserAutomation;
  readonly playwrightAvailable?: boolean;
} = {}): WebFetchAvailability {
  const automation = input.browserAutomation ?? resolveHostBrowserAutomation();
  const playwright = input.playwrightAvailable ?? isPackageResolvable("playwright");
  return automation !== undefined || playwright
    ? { available: true }
    : { available: false, reason: WEB_FETCH_UNAVAILABLE_REASON };
}

export type WebFetchAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/** 显式注入 → 宿主登记 → Playwright 回退（未安装时抛出带原因的失败）。 */
function resolveBrowserAutomation(injected: BrowserAutomation | undefined): BrowserAutomation {
  return injected ?? hostBrowserAutomation ?? createPlaywrightBrowserAutomation();
}

export function createBrowserSnapshotTool(options: BrowserToolOptions = {}): ToolExecutor {
  const automation = resolveBrowserAutomation(options.automation);
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
            sourceCallId: context.providerCallId ?? context.invocationId ?? "WebFetch",
            sourceFactId: context.invocationId,
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

/**
 * 「Playwright 这个包在当前工作区能否被解析」——宿主未登记该能力时的回退探测。
 *
 * 探测（而不是猜）是刻意的：Playwright 是可选的运行时依赖，装了就仍然算可用，
 * 这与改造前的既有行为一致；桌面宿主走的是注入的 Electron 能力，不经过这里。
 */
function isPackageResolvable(specifier: string): boolean {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

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
