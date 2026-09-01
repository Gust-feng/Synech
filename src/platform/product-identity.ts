/** Installation and data identity for Synech. */
export const PRODUCT_DISPLAY_NAME = "Synech" as const;
export const PRODUCT_NAMESPACE = "synech" as const;
export const PRODUCT_DATA_FORMAT_ID = "synech/v1-baseline-3" as const;
export const PRODUCT_APP_ID = "com.synech.app" as const;
export const PRODUCT_DEV_APP_ID = "com.synech.app.dev" as const;
export const PRODUCT_CHROMIUM_PARTITION = "persist:synech" as const;
export const PRODUCT_CONFIG_DIRECTORY_NAME = "Synech" as const;
export const PRODUCT_HOME_ENVIRONMENT_VARIABLE = "SYNECH_HOME" as const;
export const PRODUCT_MCP_BIN_ENVIRONMENT_VARIABLE = "SYNECH_MCP_BIN" as const;

export function productUserModelId(isPackaged: boolean): string {
  return isPackaged ? PRODUCT_APP_ID : PRODUCT_DEV_APP_ID;
}
