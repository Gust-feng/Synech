import { resolvePanelDesktopIconPath } from "../panel-server/panel-assets.js";
import { DESKTOP_APP_NAME, PRODUCT_CHROMIUM_PARTITION } from "./panel-desktop-identity.js";
import type { PanelLaunchArgs } from "../panel-server/panel-launch-args.js";
import type { PanelContextAttachmentSelection, PanelExternalResourceTarget, PanelServerOptions, StartedPanelServer } from "../panel-server.js";

export type PanelDesktopWindowOptions = {
  readonly title: string;
  readonly icon: string;
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

export type PanelDesktopDependencies = {
  readonly startPanelServer: (options: PanelServerOptions) => Promise<StartedPanelServer>;
  readonly createWindow: (options: PanelDesktopWindowOptions) => PanelDesktopWindowHandle;
  readonly selectDirectory?: () => Promise<string | undefined>;
  readonly selectContextAttachment?: () => Promise<PanelContextAttachmentSelection | undefined>;
  readonly selectSynechRestore?: () => Promise<string | undefined>;
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
    synechRestorePicker: args.smoke ? undefined : dependencies.selectSynechRestore,
    externalResourceOpener: args.smoke ? undefined : dependencies.openExternalResource,
  });
  const panelUrl = args.devUrl ?? server.url;
  let closePromise: Promise<void> | undefined;

  const closeServer = (): Promise<void> => {
    closePromise ??= (async () => {
      await server.close();
      dependencies.onSessionClosed?.();
    })();
    return closePromise;
  };

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
    await window.loadUrl(panelUrl);
    showPanelDesktopWindow(window);
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
    width: 1440,
    height: 960,
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
