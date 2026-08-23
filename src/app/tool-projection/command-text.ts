import {
  commandProgramFromValue,
  commandTextFromValue,
} from "../../domain/tools/presentation.js";

export function commandTextFromToolInput(input: unknown): string | undefined {
  return commandTextFromValue(input);
}

export function commandTextFromToolResult(result: unknown, input?: unknown): string | undefined {
  return commandTextFromValue(result, input);
}

export function commandProgramFromToolResult(result: unknown, input?: unknown): string | undefined {
  return commandProgramFromValue(result, input);
}
