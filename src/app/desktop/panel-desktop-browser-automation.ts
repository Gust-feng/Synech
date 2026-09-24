import { BrowserWindow, app, type Session } from "electron";
import type { BrowserAutomation, BrowserSnapshotResult } from "../tool-center/adapters/browser-tool.js";

/**
 * 用 Electron 自带 Chromium 实现宿主浏览器能力（隐藏窗口）。
 *
 * 桌面应用自带 Chromium，读一个网页不需要再引入第二套浏览器引擎。这里把
 * `BrowserAutomation` 这个宿主接缝实现成一次「加载 → 取渲染后正文」的隐藏窗口会话：
 *
 * - 窗口始终隐藏、不可聚焦、不进任务栏，不打断用户正在做的事；
 * - 独立内存分区（不落盘、不与面板窗口共享 Cookie）：抓取碰不到用户的登录态，
 *   进程退出即消失；
 * - 成功、失败、取消都在 `finally` 销毁窗口，不泄漏窗口；
 * - 导航 15s / 取文本 5s，与既有 Playwright 回退路径同一口径（可参数化）；
 * - 失败一律带真实原因：Chromium 的错误描述、超时的 URL 与时长、取消语义（AbortError）。
 *
 * 抓取的是模型给出的任意 URL，因此隐藏窗口不允许任何用户可见副作用：
 * 不许弹窗、不许下载、不许请求权限、不许出声。
 *
 * 一个必须知道的边界：抓取窗口仍然是 window，销毁它会触发 Electron 的
 * `window-all-closed`。应用生命周期不归这个适配器：桌面宿主
 * （`panel-desktop-launcher.startPanelDesktopSession`）在启动时就注册了该监听，
 * 抓取窗口因此既不会成为「所有窗口都关了」的误触发者，也不会替宿主决定退出。
 */

/** 对齐既有 Playwright 回退路径：`page.goto(..., { timeout: 15_000 })`。 */
const DEFAULT_NAVIGATION_TIMEOUT_MS = 15_000;
/** 对齐既有 Playwright 回退路径：`locator("body").innerText({ timeout: 5_000 })`。 */
const DEFAULT_TEXT_TIMEOUT_MS = 5_000;
/** 不带 `persist:` 前缀 = 内存分区：抓取不落盘，也不与面板窗口共享登录态。 */
const WEB_FETCH_PARTITION = "synech-web-fetch";
/** 分区级策略只登记一次，避免每次抓取都往同一个 Session 上追加监听。 */
const configuredFetchSessions = new WeakSet<Session>();

const READ_PAGE_SCRIPT = `(() => {
  const body = document.body;
  const text = (body === null ? document.documentElement?.innerText : body.innerText) ?? "";
  return { url: location.href, title: document.title, text };
})()`;

export type ElectronBrowserAutomationOptions = {
  readonly navigationTimeoutMs?: number;
  readonly textTimeoutMs?: number;
};

export function createElectronBrowserAutomation(
  options: ElectronBrowserAutomationOptions = {},
): BrowserAutomation {
  const navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  const textTimeoutMs = options.textTimeoutMs ?? DEFAULT_TEXT_TIMEOUT_MS;
  return {
    async snapshot(input): Promise<BrowserSnapshotResult> {
      await app.whenReady();
      if (input.abortSignal?.aborted === true) {
        throw browserCancelledError();
      }
      const window = createWebFetchWindow();
      // 取消与超时都要「销毁窗口 + 给出真实原因」，且先发生的那个原因胜出：
      // 销毁窗口本身会让在途的 loadURL 以 ERR_ABORTED 拒绝，不能让它覆盖真实原因。
      let settledError: Error | undefined;
      const terminate = (error: Error): Error => {
        settledError ??= error;
        destroyWebFetchWindow(window);
        return error;
      };
      const onAbort = (): void => {
        terminate(browserCancelledError());
      };
      input.abortSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        await withinDeadline(
          window.loadURL(input.url).catch((error: unknown) => {
            throw navigationFailure(input.url, error);
          }),
          navigationTimeoutMs,
          () => terminate(navigationTimeoutError(input.url, navigationTimeoutMs)),
        );
        await delay(input.waitMs, input.abortSignal);
        return await withinDeadline(
          readPageSnapshot(window).catch((error: unknown) => {
            throw textReadFailure(input.url, error);
          }),
          textTimeoutMs,
          () => terminate(textTimeoutError(input.url, textTimeoutMs)),
        );
      } catch (error) {
        throw settledError ?? error;
      } finally {
        input.abortSignal?.removeEventListener("abort", onAbort);
        destroyWebFetchWindow(window);
      }
    },
  };
}

function createWebFetchWindow(): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    focusable: false,
    skipTaskbar: true,
    frame: false,
    width: 1280,
    height: 900,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      partition: WEB_FETCH_PARTITION,
      // 隐藏窗口默认会节流后台页面的定时器，懒加载内容可能永远不渲染；
      // 抓取要的是「页面真的加载完」，所以关掉节流。
      backgroundThrottling: false,
    },
  });
  configureFetchSession(window.webContents.session);
  // 隐藏窗口不该发出任何声音。
  window.webContents.setAudioMuted(true);
  // 页面自己开的新窗口会以可见窗口出现，直接拒绝。
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return window;
}

function configureFetchSession(session: Session): void {
  if (configuredFetchSessions.has(session)) {
    return;
  }
  configuredFetchSessions.add(session);
  // 隐藏窗口没有可展示的权限对话框：一律拒绝，绝不替用户点「允许」。
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  // 抓取不是用户点击，不允许页面把文件写到用户磁盘上。
  session.on("will-download", (event) => {
    event.preventDefault();
  });
}

async function readPageSnapshot(window: BrowserWindow): Promise<BrowserSnapshotResult> {
  const snapshot = await window.webContents.executeJavaScript(READ_PAGE_SCRIPT, false) as {
    readonly url?: unknown;
    readonly title?: unknown;
    readonly text?: unknown;
  } | null;
  const url = typeof snapshot?.url === "string" && snapshot.url.length > 0
    ? snapshot.url
    : window.webContents.getURL();
  const title = typeof snapshot?.title === "string" ? snapshot.title : undefined;
  const text = typeof snapshot?.text === "string" ? snapshot.text : undefined;
  return { url, title, text };
}

function withinDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // `Promise.race` 会为两边都挂上处理，超时后 `operation` 的拒绝不会变成未处理拒绝。
  return Promise.race([
    operation,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function delay(waitMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (waitMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, waitMs);
    function onAbort(): void {
      clearTimeout(timer);
      reject(browserCancelledError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function destroyWebFetchWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }
  // destroy 而不是 close：抓取窗口没有需要保存的状态，也不能被页面的 beforeunload 拖住。
  window.destroy();
}

function browserCancelledError(): Error {
  const error = new Error("web fetch was cancelled.");
  error.name = "AbortError";
  return error;
}

function navigationFailure(url: string, cause: unknown): Error {
  return new Error(`web fetch could not load ${url}: ${failureMessage(cause)}`, { cause });
}

function textReadFailure(url: string, cause: unknown): Error {
  return new Error(`web fetch could not read the rendered text of ${url}: ${failureMessage(cause)}`, { cause });
}

function navigationTimeoutError(url: string, timeoutMs: number): Error {
  return new Error(`web fetch timed out after ${timeoutMs} ms while loading ${url}.`);
}

function textTimeoutError(url: string, timeoutMs: number): Error {
  return new Error(`web fetch timed out after ${timeoutMs} ms while reading the rendered text of ${url}.`);
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
