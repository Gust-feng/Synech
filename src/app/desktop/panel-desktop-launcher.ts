import { resolvePanelDesktopIconPath } from "../panel-server/panel-assets.js";
import { DESKTOP_APP_NAME, PRODUCT_CHROMIUM_PARTITION } from "./panel-desktop-identity.js";
import type { PanelLaunchArgs } from "../panel-server/panel-launch-args.js";
import { DESKTOP_WORKBENCH_HEIGHT, DESKTOP_WORKBENCH_WIDTH } from "./panel-desktop-window-geometry.js";
import type { PanelContextAttachmentSelection, PanelExternalResourceTarget, PanelServerOptions, StartedPanelServer } from "../panel-server/index.js";

export type PanelDesktopWindowOptions = {
  readonly title: string;
  readonly icon: string;
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly frame: false;
  readonly transparent: false;
  readonly resizable: true;
  readonly maximizable: true;
  readonly hasShadow: false;
  readonly center: boolean;
  readonly backgroundColor: string;
  readonly show: boolean;
  readonly autoHideMenuBar: boolean;
  readonly webPreferences: {
    readonly contextIsolation: true;
    readonly nodeIntegration: false;
    readonly sandbox: true;
    readonly webviewTag: false;
    readonly partition: typeof PRODUCT_CHROMIUM_PARTITION;
  };
};

export type PanelDesktopWindowHandle = {
  loadUrl(url: string): Promise<void>;
  onReadyToShow(handler: () => void): void;
  show(): void;
  isVisible(): boolean;
  isDestroyed(): boolean;
};

export type PanelDesktopSession = {
  readonly url: string;
  readonly productHome: string;
  readonly configDirectory: string;
  close(): Promise<void>;
};

/**
 * 把桌面启动模式作为查询参数附加到面板 URL。
 *
 * 这只是 Electron 自身启动事实的传递（安装后首次启动 / 更新后启动），
 * 供渲染端决定播放完整礼品卡展开、缩短版场景展开还是直接进入工作台。
 * URL 只负责让 renderer 选择首次安装/更新场景；窗口生命周期由 Electron 自己拥有。
 */
export function panelLaunchUrl(
  baseUrl: string,
  desktopLaunch: "installed" | "updated" | undefined,
): string {
  if (desktopLaunch === undefined) return baseUrl;
  const params = [`launch=${desktopLaunch}`];
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}${params.join("&")}`;
}

export type PanelDesktopDependencies = {
  readonly startPanelServer: (options: PanelServerOptions) => Promise<StartedPanelServer>;
  readonly configureAppStoragePaths?: (productHome: string) => void | Promise<void>;
  readonly createWindow: (options: PanelDesktopWindowOptions) => PanelDesktopWindowHandle;
  readonly selectDirectory?: () => Promise<string | undefined>;
  readonly selectContextAttachment?: () => Promise<PanelContextAttachmentSelection | undefined>;
  readonly selectRestore?: () => Promise<string | undefined>;
  readonly openExternalResource?: (target: PanelExternalResourceTarget) => Promise<void>;
  readonly whenReady: () => Promise<void>;
  readonly onWindowAllClosed: (handler: () => void) => void;
  readonly onBeforeQuit: (handler: () => Promise<void>) => void;
  readonly onSessionClosed?: () => void;
  readonly quit: () => void;
};

export async function startPanelDesktopSession(
  args: PanelLaunchArgs,
  dependencies: PanelDesktopDependencies
): Promise<PanelDesktopSession> {
  const server = await dependencies.startPanelServer({
    host: args.host,
    port: args.port,
    productHome: args.productHome,
    directoryPicker: args.smoke ? undefined : dependencies.selectDirectory,
    contextAttachmentPicker: args.smoke ? undefined : dependencies.selectContextAttachment,
    restorePicker: args.smoke ? undefined : dependencies.selectRestore,
    externalResourceOpener: args.smoke ? undefined : dependencies.openExternalResource,
  });
  let closePromise: Promise<void> | undefined;

  const closeServer = (): Promise<void> => {
    closePromise ??= (async () => {
      await server.close();
      dependencies.onSessionClosed?.();
    })();
    return closePromise;
  };

  try {
    await dependencies.configureAppStoragePaths?.(server.productHome);
  } catch (error) {
    await closeServer();
    throw error;
  }

  const panelUrl = args.devUrl ?? server.url;

  dependencies.onBeforeQuit(closeServer);
  dependencies.onWindowAllClosed(() => {
    void (async () => {
      await closeServer();
      dependencies.quit();
    })().catch((error: unknown) => {
      console.error("桌面面板退出失败。");
      console.error(error);
      dependencies.quit();
    });
  });

  if (args.smoke) {
    await closeServer();
    dependencies.quit();
    return {
      url: panelUrl,
      productHome: server.productHome,
      configDirectory: server.configDirectory,
      close: closeServer,
    };
  }

  try {
    await dependencies.whenReady();
    const options = createPanelDesktopWindowOptions();
    const window = dependencies.createWindow(options);
    window.onReadyToShow(() => {
      showPanelDesktopWindow(window);
    });
    await window.loadUrl(panelLaunchUrl(panelUrl, args.desktopLaunch));
  } catch (error) {
    await closeServer();
    throw error;
  }

  return {
    url: panelUrl,
    productHome: server.productHome,
    configDirectory: server.configDirectory,
    close: closeServer,
  };
}

function showPanelDesktopWindow(window: PanelDesktopWindowHandle): void {
  if (window.isDestroyed() || window.isVisible()) {
    return;
  }
  window.show();
}

export function createPanelDesktopWindowOptions(): PanelDesktopWindowOptions {
  return {
    title: DESKTOP_APP_NAME,
    icon: resolvePanelDesktopIconPath(),
    width: DESKTOP_WORKBENCH_WIDTH,
    height: DESKTOP_WORKBENCH_HEIGHT,
    minWidth: 960,
    minHeight: 640,
    frame: false,
    transparent: false,
    resizable: true,
    maximizable: true,
    hasShadow: false,
    center: true,
    backgroundColor: "#f4f2ef",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      partition: PRODUCT_CHROMIUM_PARTITION,
    },
  };
}
