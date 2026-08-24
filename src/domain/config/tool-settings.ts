import type { ToolConfirmationPolicy } from "../tools/contracts.js";



export type ToolStateSettings = {
  readonly name: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
};
export type ConfiguredCommandShellKind = "cmd" | "powershell" | "pwsh" | "bash" | "sh" | "auto";

export type CommandShellSettings = {
  readonly kind: ConfiguredCommandShellKind;
  readonly executable?: string;
  readonly updatedAt: string;
};

export type ToolConfirmationSettings = {
  readonly policy: ToolConfirmationPolicy;
  readonly updatedAt: string;
};

export type UpdateToolStateInput = {
  readonly name: string;
  readonly enabled: boolean;
};

export type SanitizedToolConfirmationConfig = {
  readonly policy: ToolConfirmationPolicy;
  readonly label: string;
  readonly shellCommandConfirmation: "prompt" | "skipped_by_full_access";
  readonly shellCommandRequiresConfirmation: boolean;
  readonly summary: string;
  readonly riskDisclosure: string;
  readonly updatedAt: string;
};

export type UpdateToolConfirmationConfigInput = {
  readonly policy: ToolConfirmationPolicy;
};

export type CommandShellAvailability = "available" | "missing";

export type SanitizedCommandShellOption = {
  readonly kind: Exclude<ConfiguredCommandShellKind, "auto">;
  readonly label: string;
  readonly executable?: string;
  readonly syntax: "cmd" | "powershell" | "posix";
  readonly availability: CommandShellAvailability;
  readonly reason?: string;
};

export type SanitizedRuntimeEnvironmentTool = {
  readonly id: "node" | "python" | "git-bash";
  readonly label: string;
  readonly description: string;
  readonly executable?: string;
  readonly availability: CommandShellAvailability;
  readonly reason?: string;
};

export type SanitizedCommandShellConfig = {
  readonly configuredKind: ConfiguredCommandShellKind;
  readonly autoDetected: boolean;
  readonly kind: Exclude<ConfiguredCommandShellKind, "auto">;
  readonly label: string;
  readonly executable: string;
  readonly syntax: "cmd" | "powershell" | "posix";
  readonly platform: NodeJS.Platform;
  readonly invocation: readonly string[];
  readonly commandLineParameter: "commandLine";
  readonly notes: readonly string[];
  readonly availableShells: readonly SanitizedCommandShellOption[];
  readonly runtimeTools: readonly SanitizedRuntimeEnvironmentTool[];
  readonly updatedAt: string;
};

export type UpdateCommandShellConfigInput = {
  readonly kind: ConfiguredCommandShellKind;
  readonly executable?: string;
};
