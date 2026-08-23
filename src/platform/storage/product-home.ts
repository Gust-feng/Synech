import os from "node:os";
import path from "node:path";
import {
  PRODUCT_CONFIG_DIRECTORY_NAME,
  PRODUCT_HOME_ENVIRONMENT_VARIABLE,
  PRODUCT_NAMESPACE,
} from "../product-identity.js";

export type ProductHomeEnvironment = Readonly<Record<string, string | undefined>>;

export type ResolveProductHomeOptions = {
  /** Explicit application/CLI selection. Takes precedence over every environment default. */
  readonly productHome?: string;
  readonly env?: ProductHomeEnvironment;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
};

/** Resolves the one canonical root that owns all Synech-managed local state. */
export function resolveProductHome(options: ResolveProductHomeOptions = {}): string {
  const explicit = nonBlank(options.productHome);
  if (explicit !== undefined) return path.resolve(explicit);

  const env = options.env ?? process.env;
  const configured = nonBlank(env[PRODUCT_HOME_ENVIRONMENT_VARIABLE]);
  if (configured !== undefined) return path.resolve(configured);

  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  if (platform === "win32") {
    const localAppData = nonBlank(env.LOCALAPPDATA) ?? path.join(homeDirectory, "AppData", "Local");
    return path.resolve(localAppData, PRODUCT_CONFIG_DIRECTORY_NAME);
  }
  if (platform === "darwin") {
    return path.resolve(homeDirectory, "Library", "Application Support", PRODUCT_CONFIG_DIRECTORY_NAME);
  }
  const xdgDataHome = nonBlank(env.XDG_DATA_HOME) ?? path.join(homeDirectory, ".local", "share");
  return path.resolve(xdgDataHome, PRODUCT_NAMESPACE);
}

function nonBlank(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
