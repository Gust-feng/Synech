import { commandDisplayText, type CommandTextLike } from "../../../domain/tools/presentation.js";

export type CommandDisplayProjectionLike = CommandTextLike & {
  readonly kind: "command_summary";
};

export function commandText(display: CommandDisplayProjectionLike): string | undefined {
  return commandDisplayText(display);
}

export function genericItemLabel(value: string): string {
  return value.replace(/^(?:file|dir|directory|item)\s+/i, "").trim() || value;
}
