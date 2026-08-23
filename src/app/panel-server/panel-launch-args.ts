export type PanelLaunchArgs = {
  readonly host: string;
  readonly port: number;
  readonly productHome?: string;
  readonly smoke: boolean;
  readonly devUrl?: string;
};

export const DEFAULT_PANEL_HOST = "127.0.0.1";
export const DEFAULT_PANEL_PORT = 9090;
export const DEFAULT_PANEL_DESKTOP_PORT = 0;

export function parsePanelArgs(argv: readonly string[]): PanelLaunchArgs {
  return parsePanelArgsWithDefaults(argv, { port: DEFAULT_PANEL_PORT });
}

export function parsePanelDesktopArgs(argv: readonly string[]): PanelLaunchArgs {
  return parsePanelArgsWithDefaults(argv, { port: DEFAULT_PANEL_DESKTOP_PORT });
}

function parsePanelArgsWithDefaults(
  argv: readonly string[],
  defaults: { readonly port: number }
): PanelLaunchArgs {
  let host = DEFAULT_PANEL_HOST;
  let port = defaults.port;
  let productHome: string | undefined;
  let devUrl: string | undefined;
  let smoke = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--smoke") {
      smoke = true;
      continue;
    }
    if (arg === "--host") {
      host = requireNext(argv, index, "--host");
      index += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      host = requireValue(arg.slice("--host=".length), "--host");
      continue;
    }
    if (arg === "--port") {
      port = parsePort(requireNext(argv, index, "--port"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = parsePort(requireValue(arg.slice("--port=".length), "--port"));
      continue;
    }
    if (arg === "--home") {
      productHome = requireNext(argv, index, "--home");
      index += 1;
      continue;
    }
    if (arg.startsWith("--home=")) {
      productHome = requireValue(arg.slice("--home=".length), "--home");
      continue;
    }
    if (arg === "--dev-url") {
      devUrl = requireNext(argv, index, "--dev-url");
      index += 1;
      continue;
    }
    if (arg.startsWith("--dev-url=")) {
      devUrl = requireValue(arg.slice("--dev-url=".length), "--dev-url");
      continue;
    }
    throw new Error(`Unknown panel argument: ${arg}`);
  }

  return { host, port, productHome, smoke, devUrl };
}

function requireNext(argv: readonly string[], index: number, flag: string): string {
  return requireValue(argv[index + 1], flag);
}

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${flag} requires a value.`);
  }
  return value.trim();
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port requires an integer between 0 and 65535.");
  }
  return port;
}
