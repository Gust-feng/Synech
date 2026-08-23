export class ConfigSchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigSchemaValidationError";
  }
}

export function normalizeRequiredConfigString(value: string | undefined, fieldName: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new ConfigSchemaValidationError(fieldName + " must be a non-empty string.");
  }
  return value.trim();
}

export function requiredString(value: unknown, fieldName: string): string {
  const result = optionalString(value);
  if (result === undefined) {
    throw new ConfigSchemaValidationError("Invalid settings document: " + fieldName + " must be a non-empty string.");
  }
  return result;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function safeConfigId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

export { asRecord } from "../../kernel/values/index.js";
