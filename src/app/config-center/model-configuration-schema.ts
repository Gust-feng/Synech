import { z } from "zod";
import type { ModelConfiguration, UpdateModelConfigurationInput } from "../../domain/config/index.js";
import {
  modelSettingsSchema,
  updateModelConfigurationSchema,
} from "../../domain/config/model-configuration-schema.js";
import { ConfigCenterValidationError } from "./config-center-error.js";
import { normalizeProfileId } from "./model-provider-common.js";
import { ConfigSchemaValidationError } from "./settings-utils.js";

export function parseModelSettings(
  value: unknown,
): Readonly<Record<string, ModelConfiguration>> | undefined {
  if (value === undefined) return undefined;
  const parsed = modelSettingsSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigSchemaValidationError(`Invalid model settings: ${z.prettifyError(parsed.error)}`);
  }
  return Object.keys(parsed.data).length === 0 ? undefined : parsed.data;
}

export function parseModelConfigurationUpdate(value: unknown): UpdateModelConfigurationInput {
  const parsed = updateModelConfigurationSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigCenterValidationError(`Invalid model configuration: ${z.prettifyError(parsed.error)}`);
  }
  try {
    return { ...parsed.data, profileId: normalizeProfileId(parsed.data.profileId) };
  } catch (error) {
    if (!(error instanceof ConfigSchemaValidationError)) throw error;
    throw new ConfigCenterValidationError(error.message);
  }
}
