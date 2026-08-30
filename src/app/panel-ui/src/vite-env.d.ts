declare module "*.svg" {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.svg?raw" {
  const src: string;
  export default src;
}

declare module "*.png" {
  const src: string;
  export default src;
}

interface Window {
  readonly desktopHost?: {
    readonly platform: "win32" | "darwin" | "linux" | "other";
    readonly getLocalPreference: (key: string) => string | undefined;
    readonly setLocalPreference: (key: string, value: string) => boolean;
    readonly getWindowState: () => Promise<{
      readonly maximized: boolean;
    }>;
    readonly onWindowStateChanged: (callback: (state: {
      readonly maximized: boolean;
    }) => void) => () => void;
    readonly minimizeWindow: () => void;
    readonly toggleMaximizeWindow: () => void;
    readonly closeWindow: () => void;
  };
}
