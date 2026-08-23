import { asOptionalRecord } from "../values/index.js";
import type {
  ModelOutputContract,
  ModelOutputValidationIssue,
  ModelOutputValidationResult,
  ModelRequest,
  ModelResponse,
} from "../../domain/intelligence/index.js";
import { nowIso } from "../id.js";

export type ModelRequestValidationResult = {
  readonly passed: boolean;
  readonly issues: readonly ModelOutputValidationIssue[];
};

export function validateModelRequest(request: ModelRequest): ModelRequestValidationResult {
  const issues: ModelOutputValidationIssue[] = [];
  const record = request as Partial<ModelRequest>;

  if (typeof record.requestId !== "string" || record.requestId.trim().length === 0) {
    issues.push(issue("MODEL_REQUEST_ID_REQUIRED", "ModelRequest.requestId is required.", "requestId"));
  }
  if (typeof record.traceId !== "string" || record.traceId.trim().length === 0) {
    issues.push(issue("MODEL_TRACE_ID_REQUIRED", "ModelRequest.traceId is required.", "traceId"));
  }
  if (record.callerRef === undefined || record.callerRef === null) {
    issues.push(issue("MODEL_CALLER_REF_REQUIRED", "ModelRequest.callerRef is required.", "callerRef"));
  }
  if (typeof record.purpose !== "string" || record.purpose.trim().length === 0) {
    issues.push(issue("MODEL_PURPOSE_REQUIRED", "ModelRequest.purpose is required.", "purpose"));
  }
  if (!isOutputContract(record.outputContract)) {
    issues.push(
      issue("MODEL_OUTPUT_CONTRACT_REQUIRED", "ModelRequest.outputContract is required.", "outputContract")
    );
  }
  if (!isBudget(record.budget)) {
    issues.push(issue(
      "MODEL_BUDGET_REQUIRED",
      "ModelRequest.budget must be an object; declared budget limits must be positive numbers.",
      "budget",
    ));
  }
  if (!Array.isArray(record.inputRefs)) {
    issues.push(issue("MODEL_INPUT_REFS_REQUIRED", "ModelRequest.inputRefs must be an array.", "inputRefs"));
  }
  if (!Array.isArray(record.sanitizedMessages)) {
    issues.push(
      issue("MODEL_SANITIZED_MESSAGES_REQUIRED", "ModelRequest.sanitizedMessages must be an array.", "sanitizedMessages")
    );
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}

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

function isOutputContract(value: unknown): value is ModelOutputContract {
  const record = asOptionalRecord(value);
  return (
    record !== undefined &&
    typeof record.contractId === "string" &&
    record.contractId.trim().length > 0 &&
    typeof record.outputKind === "string" &&
    (record.format === "json_object" || record.format === "text")
  );
}

function isBudget(value: unknown): boolean {
  const record = asOptionalRecord(value);
  if (record === undefined) {
    return false;
  }
  return ["maxInputTokens", "maxOutputTokens", "maxTotalTokens", "maxLatencyMs", "maxCostUsd"].every((field) => {
    const budgetValue = record[field];
    return budgetValue === undefined ||
      (typeof budgetValue === "number" && Number.isFinite(budgetValue) && budgetValue > 0);
  });
}

function issue(code: string, message: string, path?: string): ModelOutputValidationIssue {
  return { code, message, path };
}
