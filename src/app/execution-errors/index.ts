import { ModelRuntimeConfigurationError } from "../model-runtime/index.js";

export type ExecutionErrorFacts = {
  readonly code: string;
  readonly message: string;
};

/**
 * Marks an expected execution-boundary failure without coupling a feature to
 * the implementation that detected it. The cause remains available for logs.
 */
export class CodedExecutionError extends Error {
  readonly name = "CodedExecutionError";

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Returns only explicitly typed facts; callers choose their unknown-error fallback. */
export function executionErrorFacts(error: unknown): ExecutionErrorFacts | undefined {
  if (error instanceof ModelRuntimeConfigurationError) {
    return { code: error.issue.code, message: error.issue.message };
  }
  if (error instanceof CodedExecutionError) {
    return { code: error.code, message: error.message };
  }
  return undefined;
}
