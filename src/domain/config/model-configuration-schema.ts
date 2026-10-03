import { z } from "zod";
import type { ModelConfiguration } from "./model-configuration.js";

const modelIdentitySchema = z.string().trim().min(1);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const modelConfigurationSchema = z.object({
  overrides: z.object({
    contextWindowTokens: positiveSafeIntegerSchema.optional(),
    maxOutputTokens: positiveSafeIntegerSchema.optional(),
    supportsVisionInput: z.boolean().optional(),
    supportsReasoningOutput: z.boolean().optional(),
    thinkingLevels: z.array(z.enum(["low", "medium", "high", "xhigh", "max"]))
      .transform((levels) => [...new Set(levels)]).optional(),
  }).strict().optional(),
}).strict();

// Validate entries rather than a Zod record, which drops the "__proto__" key.
export const modelSettingsSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  "model settings must be an object",
).transform((value) => Object.entries(value))
  .pipe(z.array(z.tuple([modelIdentitySchema, modelConfigurationSchema])))
  .superRefine((entries, context) => {
    const ids = new Set<string>();
    for (const [index, [modelId]] of entries.entries()) {
      if (ids.has(modelId)) {
        context.addIssue({ code: "custom", path: [index, 0], message: "duplicate normalized model id" });
      }
      ids.add(modelId);
    }
  })
  .transform((entries): Record<string, ModelConfiguration> => Object.fromEntries(entries));

export const updateModelConfigurationSchema = z.object({
  profileId: modelIdentitySchema,
  modelId: modelIdentitySchema,
  settings: modelConfigurationSchema.optional(),
}).strict();
