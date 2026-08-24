import type {
  CapabilityMcpCatalogItem,
  CapabilityMcpToolCatalogItem,
  CapabilityToolCatalogItem,
  McpServerPreset,
  SanitizedWebSearchConfig,
} from "../../domain/config/index.js";
import type {
  ToolErrorDomain,
  ToolErrorFacts,
  ToolFileDisplayOperation,
} from "../../domain/tools/index.js";
import type { ToolDisplayProjection } from "./tool-display.js";

export type { ToolDisplayProjection, ToolErrorDomain, ToolErrorFacts, ToolFileDisplayOperation };

export type ToolCatalogItem = Partial<Omit<CapabilityToolCatalogItem, "name" | "scopes">> & {
  readonly name: string;
  readonly scopes?: readonly string[];
  readonly enabledByDefault?: boolean;
};

export type McpToolCatalogItem = CapabilityMcpToolCatalogItem;
export type McpServerCatalogItem = CapabilityMcpCatalogItem;
export type { McpServerPreset };

export type ToolsResponse = {
  readonly ok?: boolean;
  readonly status?: "completed" | "failed";
  readonly tools?: {
    readonly webSearch?: SanitizedWebSearchConfig;
    readonly catalog?: {
      readonly tools?: readonly ToolCatalogItem[];
    };
  };
  readonly mcpCatalog?: readonly CapabilityMcpCatalogItem[];
};

export type McpCatalogResponse = {
  readonly ok: true;
  readonly status: "completed";
  readonly catalog: readonly CapabilityMcpCatalogItem[];
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
