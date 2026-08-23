export type ToolErrorFactValue =
  | string
  | number
  | boolean
  | null
  | readonly ToolErrorFactValue[]
  | { readonly [key: string]: ToolErrorFactValue };

export type ToolErrorFacts = Readonly<Record<string, ToolErrorFactValue>>;

export type ToolErrorDomain =
  | "tool_error"
  | "runtime_error"
  | "model_error"
  | "ui_submit_error"
  | "process_error";

export type ToolFileDisplayOperation =
  | "create"
  | "write"
  | "append"
  | "edit"
  | "delete";

export type { ToolDisplayProjection } from "../../../panel-api/tool-display";

export type ToolCatalogItem = {
  readonly name: string;
  readonly displayName?: string;
  readonly displayDescription?: string;
  readonly description?: string;
  readonly category?: string;
  readonly categoryLabel?: string;
  readonly riskLevel?: string;
  readonly riskLabel?: string;
  readonly operationType?: string;
  readonly operationLabel?: string;
  readonly enabled: boolean;
  readonly available?: boolean;
  readonly unavailableReason?: string;
  readonly requiresConfirmation?: boolean;
  readonly confirmationLabel?: string;
};

export type McpToolCatalogItem = ToolCatalogItem & {
  readonly protocolName: string;
};

export type McpServerCatalogItem = {
  readonly serverId: string;
  readonly label: string;
  readonly description?: string;
  readonly transport: "stdio" | "http";
  readonly enabled: boolean;
  readonly confirmationMode?: "always" | "unsafe_only" | "never";
  readonly toolExposureMode?: "none" | "all" | "selected";
  readonly availability: "configured" | "disabled" | "unavailable";
  readonly runtimeStatus?: "disabled" | "unavailable" | "configured" | "connecting" | "connected" | "error";
  readonly errorSummary?: string;
  readonly commandSummary?: string;
  readonly url?: string;
  readonly envSecretRefCount: number;
  readonly authSecretRefCount?: number;
  readonly enabledTools?: readonly string[];
  readonly autoApprovedTools?: readonly string[];
  readonly lastConnectedAt?: string;
  readonly lastError?: string;
  readonly toolsCachedAt?: string;
  readonly cachedTools?: readonly {
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly inputSchema?: Record<string, unknown>;
    readonly outputSchema?: Record<string, unknown>;
    readonly annotations?: {
      readonly title?: string;
      readonly readOnlyHint?: boolean;
      readonly destructiveHint?: boolean;
      readonly openWorldHint?: boolean;
    };
  }[];
  readonly promptCount?: number;
  readonly resourceCount?: number;
  readonly resourceTemplateCount?: number;
  readonly referencesCachedAt?: string;
  readonly tools: readonly McpToolCatalogItem[];
  readonly exposedTools?: readonly McpToolCatalogItem[];
  readonly updatedAt: string;
};

export type ToolsResponse = {
  readonly tools?: {
    readonly webSearch?: {
      readonly provider?: string;
      readonly maxResults?: number;
      readonly secretConfigured?: boolean;
      readonly status?: "ready" | "no-provider" | "disabled";
      readonly engineId?: string;
    };
    readonly catalog?: {
      readonly tools?: readonly ToolCatalogItem[];
    };
  };
  readonly mcpCatalog?: readonly McpServerCatalogItem[];
};

export type McpEnvironmentCheckResponse = {
  readonly ok: boolean;
  readonly status:
    | "ready"
    | "missing_command"
    | "not_found"
    | "check_failed"
    | "installing"
    | "installed"
    | "unsupported"
    | "install_failed";
  readonly command?: string;
  readonly resolvedCommand?: string;
  readonly managed?: boolean;
  readonly installable?: boolean;
  readonly message: string;
  readonly checkedAt: string;
};

export type McpServerPreset = {
  readonly presetId: string;
  readonly label: string;
  readonly description: string;
  readonly server: {
    readonly serverId: string;
    readonly label?: string;
    readonly description?: string;
    readonly transport?: "stdio" | "http";
    readonly commandLine?: string;
    readonly url?: string;
    readonly envSecretRefs?: readonly string[];
    readonly confirmationMode?: "always" | "unsafe_only" | "never";
    readonly toolExposureMode?: "none" | "all" | "selected";
    readonly enabled?: boolean;
  };
};

export type McpReferenceResponse = {
  readonly ok?: boolean;
  readonly serverId?: string;
  readonly errorCode?: string;
  readonly errorSummary?: string;
  readonly prompts: readonly {
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly arguments?: readonly {
      readonly name: string;
      readonly description?: string;
      readonly required?: boolean;
    }[];
  }[];
  readonly resources: readonly {
    readonly uri: string;
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly mimeType?: string;
    readonly size?: number;
  }[];
  readonly resourceTemplates: readonly {
    readonly uriTemplate: string;
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly mimeType?: string;
  }[];
};
