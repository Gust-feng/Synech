import { modelProviderConnectionSettingsSchema } from "../../domain/config/index.js";
import type { ModelProviderConnectionSettings } from "../../domain/config/index.js";
import { ConfigSchemaValidationError } from "./settings-utils.js";

export function parseModelProviderConnectionSettings(value: unknown): ModelProviderConnectionSettings | undefined {
  if (value === undefined) return undefined;
  const result = modelProviderConnectionSettingsSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigSchemaValidationError("Invalid model service connection settings.");
  }
  return result.data;
}
