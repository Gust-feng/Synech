import type {
  SanitizedToolConfirmationConfig,
  ToolConfirmationSettings,
  UpdateToolConfirmationConfigInput,
} from "../../domain/config/index.js";
import type { ToolConfirmationPolicy } from "../../domain/tools/index.js";
import { ConfigSchemaValidationError, asRecord, optionalString } from "./settings-utils.js";

const DEFAULT_TOOL_CONFIRMATION_POLICY: ToolConfirmationPolicy = "prompt";

export function normalizeToolConfirmationPolicy(value: unknown): ToolConfirmationPolicy | undefined {
  return value === "prompt" || value === "full_access" ? value : undefined;
}

export function parseToolConfirmationSettings(
  raw: unknown,
  fallbackUpdatedAt: string
): ToolConfirmationSettings | undefined {
  if (typeof raw === "string") {
    const policy = normalizeToolConfirmationPolicy(raw);
    return policy === undefined ? undefined : { policy, updatedAt: fallbackUpdatedAt };
  }
  const record = asRecord(raw);
  if (Object.keys(record).length === 0) {
    return undefined;
  }
  return normalizeToolConfirmationSettings({
    policy: normalizeToolConfirmationPolicy(record.policy) ?? DEFAULT_TOOL_CONFIRMATION_POLICY,
    updatedAt: optionalString(record.updatedAt) ?? fallbackUpdatedAt,
  }, fallbackUpdatedAt);
}

export function normalizeToolConfirmationSettings(
  settings: ToolConfirmationSettings | undefined,
  now: string
): ToolConfirmationSettings {
  return {
    policy: normalizeToolConfirmationPolicy(settings?.policy) ?? DEFAULT_TOOL_CONFIRMATION_POLICY,
    updatedAt: optionalString(settings?.updatedAt) ?? now,
  };
}

export function normalizeToolConfirmationUpdate(
  input: UpdateToolConfirmationConfigInput,
  now: string
): ToolConfirmationSettings {
  const policy = normalizeToolConfirmationPolicy(input.policy);
  if (policy === undefined) {
    throw new ConfigSchemaValidationError("toolConfirmation.policy must be prompt or full_access.");
  }
  return {
    policy,
    updatedAt: now,
  };
}

export function toSanitizedToolConfirmationConfig(
  settings: ToolConfirmationSettings | undefined,
  input: { readonly now?: string } = {}
): SanitizedToolConfirmationConfig {
  const normalized = normalizeToolConfirmationSettings(settings, input.now ?? new Date().toISOString());
  if (normalized.policy === "full_access") {
    return {
      policy: normalized.policy,
      label: "完全访问",
      shellCommandConfirmation: "skipped_by_full_access",
      shellCommandRequiresConfirmation: false,
      summary: "shell 会跳过逐条确认。",
      riskDisclosure: "这不是 sandbox；工具仍经过 ToolCenter、事件、runtime facts 和日志。",
      updatedAt: normalized.updatedAt,
    };
  }
  return {
    policy: normalized.policy,
    label: "标准访问",
    shellCommandConfirmation: "prompt",
    shellCommandRequiresConfirmation: true,
    summary: "shell 执行前需要确认。",
    riskDisclosure: "命令执行前由确认门阻塞，批准后仍通过 ToolCenter 执行并记录。",
    updatedAt: normalized.updatedAt,
  };
}
