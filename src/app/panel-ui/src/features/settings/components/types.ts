export type { ModelForm } from "../model/settings";

export type ToolForm = {
  readonly provider: string;
  readonly apiKey: string;
  readonly maxResults: string;
  readonly engineId: string;
};

export type McpServerForm = {
  readonly serverId: string;
  readonly label: string;
  readonly description: string;
  readonly transport: "stdio" | "http";
  readonly authMode: "none" | "bearer" | "api_key" | "custom_header";
  readonly authTouched: boolean;
  readonly confirmationMode: "always" | "unsafe_only" | "never";
  readonly toolExposureMode: "none" | "all" | "selected";
  readonly enabledTools: readonly string[];
  readonly autoApprovedTools: readonly string[];
  readonly command: string;
  readonly args: string;
  readonly commandLine: string;
  readonly url: string;
  readonly envSecretRefs: string;
  readonly headerSecretRefs: string;
  readonly bearerTokenSecretRef: string;
  readonly bearerTokenValue: string;
  readonly apiKeySecretRef: string;
  readonly apiKeyHeaderName: string;
  readonly apiKeyValue: string;
  readonly customHeaderName: string;
  readonly customHeaderValue: string;
  readonly enabled: boolean;
};

export type SettingsGroup =
  | "models"
  | "basicCapabilities"
  | "mcp"
  | "skills"
  | "subAgents"
  | "workspace"
  | "appearance"
  | "statistics"
  | "developer"
  | "about";
