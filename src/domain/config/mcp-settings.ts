import type { ToolInputSchema } from "../tools/contracts.js";

import type { ToolJsonSchema } from "../tools/schema.js";



export type McpServerTransportKind = "stdio" | "http";

export type McpConfirmationMode = "always" | "unsafe_only" | "never";

export type McpToolExposureMode = "none" | "all" | "selected";

export type McpCachedToolInfo = {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: ToolInputSchema;
  readonly outputSchema?: ToolJsonSchema;
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly openWorldHint?: boolean;
  };
};
export type McpCachedReferenceInfo = {
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

export type McpServerSettings = {
  readonly serverId: string;
  readonly label: string;
  readonly description?: string;
  readonly transport: McpServerTransportKind;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly envSecretRefs: readonly string[];
  readonly headerSecretRefs?: readonly string[];
  readonly bearerTokenSecretRef?: string;
  readonly apiKeySecretRef?: string;
  readonly apiKeyHeaderName?: string;
  readonly confirmationMode: McpConfirmationMode;
  readonly toolExposureMode: McpToolExposureMode;
  readonly enabledTools: readonly string[];
  readonly autoApprovedTools: readonly string[];
  readonly enabled: boolean;
  readonly lastConnectedAt?: string;
  readonly lastError?: string;
  readonly cachedTools?: readonly McpCachedToolInfo[];
  readonly toolsCachedAt?: string;
  readonly cachedReferences?: McpCachedReferenceInfo;
  readonly referencesCachedAt?: string;
  readonly updatedAt: string;
};

export type UpsertMcpServerInput = {
  readonly serverId: string;
  readonly label?: string;
  readonly description?: string;
  readonly transport?: McpServerTransportKind;
  readonly commandLine?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly envSecretRefs?: readonly string[];
  readonly headerSecretRefs?: readonly string[];
  readonly bearerTokenSecretRef?: string;
  readonly apiKeySecretRef?: string;
  readonly apiKeyHeaderName?: string;
  readonly clearMcpAuth?: boolean;
  readonly confirmationMode?: McpConfirmationMode;
  readonly toolExposureMode?: McpToolExposureMode;
  readonly enabledTools?: readonly string[];
  readonly autoApprovedTools?: readonly string[];
  readonly enabled?: boolean;
};

export type McpServerSecretValueInput = {
  readonly serverId: string;
  readonly secretRef: string;
  readonly value: string;
};
