export type ConfiguredWebSearchProvider =
  | "tavily"
  | "exa"
  | "zai"
  | "metaso"
  | "google"
  | "bing"
  | "model_builtin"
  | "none";

export type ConfiguredWebSearchProviderKind = Exclude<ConfiguredWebSearchProvider, "none" | "model_builtin">;

export type InformationAccessSettings = {
  readonly webSearch: {
    readonly provider: ConfiguredWebSearchProvider;
    readonly updatedAt: string;
  };
  readonly tavily: WebSearchProviderSettings & { readonly providerKind: "tavily" };
  readonly exa: WebSearchProviderSettings & { readonly providerKind: "exa" };
  readonly zai: WebSearchProviderSettings & { readonly providerKind: "zai" };
  readonly metaso: WebSearchProviderSettings & { readonly providerKind: "metaso" };
  readonly google: WebSearchProviderSettings & { readonly providerKind: "google" };
  readonly bing: WebSearchProviderSettings & { readonly providerKind: "bing" };
};
export type WebSearchProviderSettings = {
  readonly providerKind: ConfiguredWebSearchProviderKind;
  readonly maxResults: number;
  readonly secretRef: string;
  readonly endpoint?: string;
  readonly searchDepth?: string;
  readonly searchType?: string;
  readonly searchEngine?: string;
  readonly engineId?: string;
  readonly market?: string;
  readonly updatedAt: string;
};

export type SanitizedInformationAccessConfig = {
  readonly web: {
    readonly provider: ConfiguredWebSearchProvider;
    readonly providerKind?: ConfiguredWebSearchProviderKind;
    readonly maxResults: number;
    readonly secretRef?: string;
    readonly secretConfigured: boolean;
    readonly secretUpdatedAt?: string;
    readonly endpoint?: string;
    readonly searchDepth?: string;
    readonly searchType?: string;
    readonly searchEngine?: string;
    readonly engineId?: string;
    readonly market?: string;
    readonly status: "ready" | "no-provider" | "disabled";
    readonly updatedAt: string;
  };
};

export type SanitizedWebSearchConfig = {
  readonly provider: ConfiguredWebSearchProvider;
  readonly providerKind?: ConfiguredWebSearchProviderKind;
  readonly maxResults: number;
  readonly secretRef?: string;
  readonly secretConfigured: boolean;
  readonly secretUpdatedAt?: string;
  readonly endpoint?: string;
  readonly searchDepth?: string;
  readonly searchType?: string;
  readonly searchEngine?: string;
  readonly engineId?: string;
  readonly market?: string;
  readonly status: "ready" | "no-provider" | "disabled";
  readonly updatedAt: string;
};

type WebSearchRuntimeConfigBase = {
  readonly apiKey: string;
  readonly maxResults: number;
  readonly endpoint?: string;
  readonly searchDepth?: string;
  readonly searchType?: string;
  readonly searchEngine?: string;
  readonly market?: string;
};

/** Complete external search configuration owned by one Agent run. */
export type WebSearchRuntimeConfig =
  | (WebSearchRuntimeConfigBase & {
      readonly provider: "google";
      readonly engineId: string;
    })
  | (WebSearchRuntimeConfigBase & {
      readonly provider: Exclude<ConfiguredWebSearchProviderKind, "google">;
      readonly engineId?: string;
    });

export type UpdateInformationAccessConfigInput = {
  readonly provider?: ConfiguredWebSearchProvider;
  readonly apiKey?: string;
  readonly maxResults?: number;
  readonly engineId?: string;
};

export type UpdateWebSearchConfigInput = {
  readonly provider?: ConfiguredWebSearchProvider;
  readonly apiKey?: string;
  readonly maxResults?: number;
  readonly engineId?: string;
};
