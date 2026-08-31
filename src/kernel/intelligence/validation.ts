import { asOptionalRecord } from "../values/index.js";
import type {
  ModelOutputContract,
  ModelOutputValidationIssue,
  ModelOutputValidationResult,
  ModelRequest,
  ModelResponse,
} from "../../domain/intelligence/index.js";
import { nowIso } from "../id.js";

export function validateModelResponse(
  request: ModelRequest,
  response: ModelResponse
): ModelOutputValidationResult {
  if (response.status !== "completed") {
    return {
      status: "failed",
      checkedAt: nowIso(),
      issues: [
        issue(
          "MODEL_RESPONSE_NOT_COMPLETED",
          response.failure?.message ?? "Provider response did not complete.",
          "status"
        ),
      ],
    };
  }

  if ((response.toolCalls?.length ?? 0) > 0) {
    return {
      status: "passed",
      checkedAt: nowIso(),
      issues: [],
    };
  }

  return validateOutputContract(request.outputContract, response.structuredOutput, response.textOutput);
}

export function validateOutputContract(
  contract: ModelOutputContract,
  structuredOutput: unknown,
  textOutput?: string
): ModelOutputValidationResult {
  const issues: ModelOutputValidationIssue[] = [];

  if (contract.format === "json_object") {
    const objectOutput = asOptionalRecord(structuredOutput);
    if (objectOutput === undefined) {
      issues.push(issue("MODEL_OUTPUT_NOT_OBJECT", "Model output must be a JSON object.", "structuredOutput"));
    } else {
      for (const field of contract.requiredFields ?? []) {
        if (!(field in objectOutput)) {
          issues.push(issue("MODEL_OUTPUT_FIELD_REQUIRED", `Model output is missing field ${field}.`, field));
        }
      }
      for (const field of contract.requiredStringFields ?? []) {
        if (typeof objectOutput[field] !== "string" || String(objectOutput[field]).trim().length === 0) {
          issues.push(
            issue("MODEL_OUTPUT_STRING_FIELD_REQUIRED", `Model output field ${field} must be a non-empty string.`, field)
          );
        }
      }
    }
  } else {
    const text = textOutput ?? (typeof structuredOutput === "string" ? structuredOutput : undefined);
    if (typeof text !== "string") {
      issues.push(issue("MODEL_OUTPUT_TEXT_REQUIRED", "Model output must include text.", "textOutput"));
    } else {
      if (contract.minTextLength !== undefined && text.length < contract.minTextLength) {
        issues.push(issue("MODEL_OUTPUT_TEXT_TOO_SHORT", "Model output text is shorter than required.", "textOutput"));
      }
      if (contract.maxTextLength !== undefined && text.length > contract.maxTextLength) {
        issues.push(issue("MODEL_OUTPUT_TEXT_TOO_LONG", "Model output text is longer than allowed.", "textOutput"));
      }
    }
  }

  return {
    status: issues.length === 0 ? "passed" : "failed",
    checkedAt: nowIso(),
    issues,
  };
}

export function pendingModelOutputValidation(): ModelOutputValidationResult {
  return {
    status: "pending",
    checkedAt: nowIso(),
    issues: [],
  };
}

export function failedModelOutputValidation(
  code: string,
  message: string,
  path?: string
): ModelOutputValidationResult {
  return {
    status: "failed",
    checkedAt: nowIso(),
    issues: [issue(code, message, path)],
  };
}

function issue(code: string, message: string, path?: string): ModelOutputValidationIssue {
  return { code, message, path };
}
