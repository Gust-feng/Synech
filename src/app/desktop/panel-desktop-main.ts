import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  screen,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
  type Rectangle,
} from "electron";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePanelDesktopArgs } from "../panel-server/panel-launch-args.js";
import { createDesktopLocalPreferenceStore, type DesktopLocalPreferenceStore } from "./panel-desktop-local-preferences.js";
import {
  createPanelDesktopWindowOptions,
  startPanelDesktopSession,
  type PanelDesktopSession,
} from "./panel-desktop-launcher.js";
import {
  createDesktopWindowNativeEventState,
  readDesktopWindowPresentationState,
  recordDesktopWindowMaximized,
  toggleDesktopWindowMaximize,
  type DesktopWindowNativeEventState,
  type DesktopWindowPresentationState,
} from "./panel-desktop-window-controls.js";
import { startLocalPanelServer } from "../panel-server.js";
import {
  DESKTOP_APP_NAME,
  DESKTOP_USER_DATA_DIRECTORY_NAME,
  desktopAppUserModelId,
} from "./panel-desktop-identity.js";

const activeWindows = new Set<BrowserWindow>();
const activeDesktopSessions = new Set<PanelDesktopSession>();

// node:sqlite 是项目正式采用的运行时存储，其 ExperimentalWarning 每次启动都会
// 打印且无信息量；接管 warning 事件后 Node 不再走默认打印，这里只静默该条，
// 其余警告保持原有可见性。
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) {
    return;
  }
  console.warn(warning.stack ?? warning.message);
});
const desktopWindowStates = new WeakMap<BrowserWindow, DesktopWindowState>();
let desktopLocalPreferenceStore: DesktopLocalPreferenceStore | undefined;
let desktopExitCleanup: Promise<void> | undefined;
const WINDOW_MINIMIZE_CHANNEL = "synech:window-minimize";
const WINDOW_TOGGLE_MAXIMIZE_CHANNEL = "synech:window-toggle-maximize";
const WINDOW_GET_STATE_CHANNEL = "synech:window-get-state";
const WINDOW_STATE_CHANGED_CHANNEL = "synech:window-state-changed";
const WINDOW_CLOSE_CHANNEL = "synech:window-close";
const LOCAL_PREFERENCE_GET_CHANNEL = "synech:local-preference-get";
const LOCAL_PREFERENCE_SET_CHANNEL = "synech:local-preference-set";
type DesktopWindowState = {
  readonly nativeWindowEvents: DesktopWindowNativeEventState;
};

// NOTE: 不使用顶层 await，因为 ESM 顶层 await 会阻塞事件循环，
// 导致 app.whenReady() 永远无法 resolve（死锁）。
main().catch((error: unknown) => {
  console.error("应用桌面面板启动失败。");
  console.error(error);
  exitDesktopAfterCleanup(1);
});

async function main(): Promise<void> {
  configureDesktopAppIdentity();
  installDesktopLocalPreferenceBridge();
  installDesktopWindowControlBridge();
  const args = parsePanelDesktopArgs(process.argv.slice(2));
  let sessionRef: PanelDesktopSession | undefined;
  try {
    const session = await startPanelDesktopSession(args, {
      startPanelServer: startLocalPanelServer,
      createWindow: (options) => createElectronPanelWindow(options),
      selectDirectory: selectDirectory,
      selectContextAttachment: selectContextAttachment,
      selectSynechRestore: selectSynechRestore,
      openExternalResource: openExternalResource,
      whenReady: app.whenReady(),
      onWindowAllClosed: (handler) => {
        app.on("window-all-closed", () => {
          void handler();
        });
      },
      onBeforeQuit: (handler) => {
        let cleanupStarted = false;
        let cleanupComplete = false;
        app.on("before-quit", (event) => {
          if (cleanupComplete) {
            return;
          }
          event.preventDefault();
          if (cleanupStarted) {
            return;
          }
          cleanupStarted = true;
          void handler()
            .catch((error: unknown) => {
              console.error("关闭桌面面板服务器失败。");
              console.error(error);
            })
            .finally(() => {
              cleanupComplete = true;
              app.quit();
            });
        });
      },
      onSessionClosed: () => {
        if (sessionRef !== undefined) {
          activeDesktopSessions.delete(sessionRef);
          sessionRef = undefined;
        }
      },
      quit: () => {
        app.quit();
      },
    });
    sessionRef = session;

    if (!args.smoke) {
      activeDesktopSessions.add(session);
    }

    console.log(`Synech 本地桌面面板：${session.url}`);
    if (session.configDirectory !== undefined) {
      console.log(`配置目录：${session.configDirectory}`);
    }
  } catch (error) {
    console.error("应用桌面面板启动失败。");
    console.error(error);
    exitDesktopAfterCleanup(1);
  }
}

function exitDesktopAfterCleanup(exitCode: number): void {
  desktopExitCleanup ??= (async () => {
    const results = await Promise.allSettled(
      [...activeDesktopSessions].map((session) => session.close())
    );
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("强制退出前关闭桌面面板服务器失败。");
        console.error(result.reason);
      }
    }
    app.exit(exitCode);
  })();
}

function configureDesktopAppIdentity(): void {
  app.setName(DESKTOP_APP_NAME);
  if (process.platform === "win32") {
    app.setAppUserModelId(desktopAppUserModelId(app.isPackaged));
  }
  try {
    app.setPath("userData", path.join(app.getPath("appData"), DESKTOP_USER_DATA_DIRECTORY_NAME));
  } catch {
    // Electron may reject path changes in unusual embed contexts; app identity still remains set.
  }
}

async function selectDirectory(): Promise<string | undefined> {
  await app.whenReady();
  const window = currentPanelDialogWindow();
  const options: OpenDialogOptions = {
    title: "选择工作空间",
    properties: ["openDirectory"],
  };
  const result = window === undefined
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(window, options);
  return result.canceled ? undefined : result.filePaths[0];
}

async function selectContextAttachment(): Promise<{ readonly kind: "file" | "project"; readonly path: string } | undefined> {
  await app.whenReady();
  const window = currentPanelDialogWindow();
  const options: OpenDialogOptions = {
    title: "选择附件",
    properties: ["openFile"],
    filters: [{ name: "所有文件", extensions: ["*"] }],
  };
  const result = window === undefined
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(window, options);
  if (result.canceled) {
    return undefined;
  }
  const selectedPath = result.filePaths[0];
  if (selectedPath === undefined) {
    return undefined;
  }
  const selectedStat = await stat(selectedPath).catch(() => undefined);
  return {
    kind: selectedStat?.isDirectory() === true ? "project" : "file",
    path: selectedPath,
  };
}

async function selectSynechRestore(): Promise<string | undefined> {
  await app.whenReady();
  const window = currentPanelDialogWindow();
  const options: OpenDialogOptions = {
    title: "选择 应用数据备份",
    properties: ["openFile"],
    filters: [{ name: "SQLite 数据库", extensions: ["sqlite3", "sqlite", "db"] }],
  };
  const result = window === undefined
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(window, options);
  return result.canceled ? undefined : result.filePaths[0];
}

async function openExternalResource(target: { readonly kind: "path" | "url"; readonly value: string }): Promise<void> {
  if (target.kind === "url") {
    await shell.openExternal(target.value);
    return;
  }
  const error = await shell.openPath(target.value);
  if (error.length > 0) throw new Error(error);
}

function currentPanelDialogWindow(): BrowserWindow | undefined {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow !== null && activeWindows.has(focusedWindow) && !focusedWindow.isDestroyed()) {
    return focusedWindow;
  }
  return [...activeWindows].find((candidate) => !candidate.isDestroyed());
}

function createElectronPanelWindow(
  options: ReturnType<typeof createPanelDesktopWindowOptions> = createPanelDesktopWindowOptions()
) {
  const targetBounds = centeredBoundsForPrimaryDisplay(options.width, options.height);
  const mainWindow = new BrowserWindow({
    ...options,
    x: targetBounds.x,
    y: targetBounds.y,
    width: targetBounds.width,
    height: targetBounds.height,
    show: false,
    webPreferences: {
      ...options.webPreferences,
      preload: getPanelDesktopPreloadPath(),
    },
  });
  activeWindows.add(mainWindow);
  desktopWindowStates.set(mainWindow, {
    nativeWindowEvents: createDesktopWindowNativeEventState(),
  });
  registerDesktopWindowCleanup(mainWindow);
  mainWindow.on("unmaximize", () => {
    const state = desktopWindowStates.get(mainWindow);
    if (state === undefined) return;
    recordDesktopWindowMaximized(state.nativeWindowEvents, false);
    notifyCurrentDesktopWindowState(mainWindow);
  });
  mainWindow.on("maximize", () => {
    const state = desktopWindowStates.get(mainWindow);
    if (state === undefined) return;
    recordDesktopWindowMaximized(state.nativeWindowEvents, true);
    notifyCurrentDesktopWindowState(mainWindow);
  });
  mainWindow.on("leave-full-screen", () => {
    notifyCurrentDesktopWindowState(mainWindow);
  });
  mainWindow.on("enter-full-screen", () => {
    notifyCurrentDesktopWindowState(mainWindow);
  });
  let readyToShowHandler: (() => void) | undefined;
  mainWindow.once("ready-to-show", () => {
    readyToShowHandler?.();
  });

  return {
    loadUrl: async (url: string) => {
      await mainWindow.loadURL(url);
    },
    onReadyToShow: (handler: () => void) => {
      readyToShowHandler = handler;
    },
    show: () => {
      showWindowIfAlive(mainWindow);
    },
    isVisible: () => mainWindow.isVisible(),
    isDestroyed: () => mainWindow.isDestroyed(),
  };
}

function registerDesktopWindowCleanup(window: BrowserWindow): void {
  window.once("closed", () => {
    activeWindows.delete(window);
  });
}

function installDesktopWindowControlBridge(): void {
  ipcMain.handle(WINDOW_GET_STATE_CHANNEL, (event: IpcMainInvokeEvent): DesktopWindowPresentationState => {
    const window = panelWindowFromEvent(event);
    if (window === undefined) return createDefaultDesktopWindowState();
    const state = desktopWindowStates.get(window);
    if (state === undefined) return createDefaultDesktopWindowState();
    return readDesktopWindowPresentationState(window, state.nativeWindowEvents);
  });
  ipcMain.on(WINDOW_MINIMIZE_CHANNEL, (event: IpcMainEvent) => {
    const window = panelWindowFromEvent(event);
    if (window === undefined) return;
    window.minimize();
  });
  ipcMain.on(WINDOW_TOGGLE_MAXIMIZE_CHANNEL, (event: IpcMainEvent) => {
    const window = panelWindowFromEvent(event);
    if (window === undefined) return;
    const state = desktopWindowStates.get(window);
    if (state === undefined) return;
    toggleDesktopWindowMaximize(window, state.nativeWindowEvents);
  });
  ipcMain.on(WINDOW_CLOSE_CHANNEL, (event: IpcMainEvent) => {
    const window = panelWindowFromEvent(event);
    if (window === undefined) return;
    window.close();
  });
}

function installDesktopLocalPreferenceBridge(): void {
  ipcMain.on(LOCAL_PREFERENCE_GET_CHANNEL, (event, key: unknown) => {
    event.returnValue = getDesktopLocalPreferenceStore().read(key);
  });
  ipcMain.on(LOCAL_PREFERENCE_SET_CHANNEL, (event, payload: unknown) => {
    event.returnValue = getDesktopLocalPreferenceStore().write(payload);
  });
}

function getDesktopLocalPreferenceStore(): DesktopLocalPreferenceStore {
  if (desktopLocalPreferenceStore === undefined) {
    desktopLocalPreferenceStore = createDesktopLocalPreferenceStore({
      userDataDirectory: app.getPath("userData"),
    });
  }
  return desktopLocalPreferenceStore;
}

function panelWindowFromEvent(event: Pick<IpcMainEvent, "sender">): BrowserWindow | undefined {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null || !activeWindows.has(window) || window.isDestroyed()) {
    return undefined;
  }
  return window;
}

function createDefaultDesktopWindowState(): DesktopWindowPresentationState {
  return {
    maximized: false,
  };
}

function notifyDesktopWindowState(
  window: BrowserWindow,
  state: DesktopWindowPresentationState
): void {
  if (window.isDestroyed()) return;
  window.webContents.send(WINDOW_STATE_CHANGED_CHANNEL, state);
}

function notifyCurrentDesktopWindowState(window: BrowserWindow): void {
  const state = desktopWindowStates.get(window);
  if (state === undefined) return;
  notifyDesktopWindowState(window, readDesktopWindowPresentationState(window, state.nativeWindowEvents));
}

function showWindowIfAlive(window: BrowserWindow): void {
  if (window.isDestroyed() || window.isVisible()) return;
  window.show();
}

function centeredBoundsForPrimaryDisplay(width: number, height: number): Rectangle {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

function getPanelDesktopPreloadPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "panel-desktop-preload.cjs");
}
