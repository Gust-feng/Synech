import { asOptionalRecord, stringOrUndefined } from "../../../kernel/values/index.js";
import type { ToolExecutor, ToolExecutionContext } from "../../../domain/tools/index.js";

export type FetchLike = (
  url: string,
  init: {
    readonly method: "GET" | "POST";
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  }
) => Promise<FetchLikeResponse>;

export type FetchLikeResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
  readonly text?: () => Promise<string>;
};

export type WebSearchProvider = "tavily" | "exa" | "zai" | "metaso" | "google" | "bing" | "none";

export type WebSearchToolOptions = {
  readonly provider?: WebSearchProvider;
  readonly apiKey?: string;
  readonly maxResults?: number;
  readonly endpoint?: string;
  readonly googleEngineId?: string;
  readonly tavilySearchDepth?: string;
  readonly exaSearchType?: string;
  readonly zaiSearchEngine?: string;
  readonly bingMarket?: string;
  readonly fetch?: FetchLike;
};

export type WebSearchToolOutput = {
  readonly provider: WebSearchProvider;
  readonly status: "completed" | "no_search_provider" | "invalid_input" | "provider_failed";
  readonly searched: boolean;
  readonly query: string;
  readonly results: readonly {
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
    readonly source?: string;
    readonly publishedAt?: string;
  }[];
  readonly message?: string;
};

const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";
const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
const ZAI_SEARCH_ENDPOINT = "https://api.z.ai/api/paas/v4/web_search";
const METASO_SEARCH_ENDPOINT = "https://metaso.cn/api/open/search/v2";
const GOOGLE_CUSTOM_SEARCH_ENDPOINT = "https://www.googleapis.com/customsearch/v1";
const BING_WEB_SEARCH_ENDPOINT = "https://api.bing.microsoft.com/v7.0/search";
const DEFAULT_MAX_RESULTS = 5;

export function createWebSearchTool(options: WebSearchToolOptions = {}): ToolExecutor {
  return {
    definition: {
      name: "WebSearch",
      description: "Search the web for current information only when a real provider is configured. Without a provider, returns no_search_provider and does not claim a search occurred.",
      metadata: {
        category: "web",
        riskLevel: "low",
        operationType: "read-only",
        requiresConfirmation: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
    execute: (input, context) => executeWebSearch(input, context, options),
  };
}

async function executeWebSearch(
  input: unknown,
  _context: ToolExecutionContext,
  options: WebSearchToolOptions
): Promise<WebSearchToolOutput> {
  const query = queryFromInput(input);
  if (_context.abortSignal?.aborted === true) {
    return {
      provider: "none",
      status: "provider_failed",
      searched: false,
      query: "",
      results: [],
      message: "WebSearch was cancelled.",
    };
  }
  if (query === undefined) {
    return {
      provider: "none",
      status: "invalid_input",
      searched: false,
      query: "",
      results: [],
      message: "WebSearch requires a non-empty string query.",
    };
  }

  const fetchImpl = options.fetch ?? resolveGlobalFetch();
  const apiKey = normalizeOptionalString(options.apiKey);
  const provider = normalizeProvider(options.provider);
  const requiredMissing = requiredProviderConfigurationMissing(provider, options);
  if (provider === "none" || apiKey === undefined || fetchImpl === undefined || requiredMissing !== undefined) {
    return {
      provider: "none",
      status: "no_search_provider",
      searched: false,
      query,
      results: [],
      message: requiredMissing ?? `No configured ${providerLabel(provider)} search provider; no live web search was performed.`,
    };
  }

  const maxResults = maxResultsForProvider(provider, options.maxResults);
  try {
    return await executeProviderSearch({
      provider,
      query,
      apiKey,
      maxResults,
      fetch: fetchImpl,
      signal: _context.abortSignal,
      options,
    });
  } catch (error) {
    return {
      provider,
      status: "provider_failed",
      searched: true,
      query,
      results: [],
      message: error instanceof Error ? error.message : `${providerLabel(provider)} search failed.`,
    };
  }
}

async function executeProviderSearch(input: {
  readonly provider: Exclude<WebSearchProvider, "none">;
  readonly query: string;
  readonly apiKey: string;
  readonly maxResults: number;
  readonly fetch: FetchLike;
  readonly signal?: AbortSignal;
  readonly options: WebSearchToolOptions;
}): Promise<WebSearchToolOutput> {
  if (input.provider === "tavily") {
    return searchTavily(input);
  }
  if (input.provider === "exa") {
    return searchExa(input);
  }
  if (input.provider === "zai") {
    return searchZai(input);
  }
  if (input.provider === "metaso") {
    return searchMetaso(input);
  }
  if (input.provider === "google") {
    return searchGoogle(input);
  }
  return searchBing(input);
}

async function searchTavily(input: ProviderSearchInput): Promise<WebSearchToolOutput> {
  const response = await input.fetch(input.options.endpoint ?? TAVILY_SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      api_key: input.apiKey,
      query: input.query,
      max_results: input.maxResults,
      search_depth: input.options.tavilySearchDepth ?? "basic",
    }),
    signal: input.signal,
  });
  if (!response.ok) {
    return providerFailed(input, response.status);
  }
  const raw = await response.json();
  return {
    provider: input.provider,
    status: "completed",
    searched: true,
    query: input.query,
    results: resultsFromTavily(raw).slice(0, input.maxResults),
  };
}

async function searchExa(input: ProviderSearchInput): Promise<WebSearchToolOutput> {
  const response = await input.fetch(input.options.endpoint ?? EXA_SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": input.apiKey,
    },
    body: JSON.stringify({
      query: input.query,
      numResults: input.maxResults,
      type: input.options.exaSearchType ?? "auto",
      contents: {
        highlights: true,
      },
    }),
    signal: input.signal,
  });
  if (!response.ok) {
    return providerFailed(input, response.status);
  }
  const raw = await response.json();
  return {
    provider: input.provider,
    status: "completed",
    searched: true,
    query: input.query,
    results: resultsFromExa(raw).slice(0, input.maxResults),
  };
}

async function searchZai(input: ProviderSearchInput): Promise<WebSearchToolOutput> {
  const response = await input.fetch(input.options.endpoint ?? ZAI_SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      search_engine: input.options.zaiSearchEngine ?? "search-prime",
      search_query: input.query,
      count: input.maxResults,
    }),
    signal: input.signal,
  });
  if (!response.ok) {
    return providerFailed(input, response.status);
  }
  const raw = await response.json();
  return {
    provider: input.provider,
    status: "completed",
    searched: true,
    query: input.query,
    results: resultsFromZai(raw).slice(0, input.maxResults),
  };
}

async function searchMetaso(input: ProviderSearchInput): Promise<WebSearchToolOutput> {
  const response = await input.fetch(input.options.endpoint ?? METASO_SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      question: input.query,
      lang: "zh",
    }),
    signal: input.signal,
  });
  if (!response.ok) {
    return providerFailed(input, response.status);
  }
  const raw = await response.json();
  return {
    provider: input.provider,
    status: "completed",
    searched: true,
    query: input.query,
    results: resultsFromMetaso(raw).slice(0, input.maxResults),
  };
}

async function searchGoogle(input: ProviderSearchInput): Promise<WebSearchToolOutput> {
  const url = new URL(input.options.endpoint ?? GOOGLE_CUSTOM_SEARCH_ENDPOINT);
  url.searchParams.set("key", input.apiKey);
  url.searchParams.set("cx", normalizeOptionalString(input.options.googleEngineId) ?? "");
  url.searchParams.set("q", input.query);
  url.searchParams.set("num", String(Math.min(10, input.maxResults)));
  const response = await input.fetch(url.toString(), {
    method: "GET",
    headers: {
      accept: "application/json",
    },
    signal: input.signal,
  });
  if (!response.ok) {
    return providerFailed(input, response.status);
  }
  const raw = await response.json();
  return {
    provider: input.provider,
    status: "completed",
    searched: true,
    query: input.query,
    results: resultsFromGoogle(raw).slice(0, input.maxResults),
  };
}

async function searchBing(input: ProviderSearchInput): Promise<WebSearchToolOutput> {
  const url = new URL(input.options.endpoint ?? BING_WEB_SEARCH_ENDPOINT);
  url.searchParams.set("q", input.query);
  url.searchParams.set("count", String(input.maxResults));
  url.searchParams.set("responseFilter", "Webpages");
  const market = normalizeOptionalString(input.options.bingMarket);
  if (market !== undefined) {
    url.searchParams.set("mkt", market);
  }
  const response = await input.fetch(url.toString(), {
    method: "GET",
    headers: {
      accept: "application/json",
      "Ocp-Apim-Subscription-Key": input.apiKey,
    },
    signal: input.signal,
  });
  if (!response.ok) {
    return providerFailed(input, response.status);
  }
  const raw = await response.json();
  return {
    provider: input.provider,
    status: "completed",
    searched: true,
    query: input.query,
    results: resultsFromBing(raw).slice(0, input.maxResults),
  };
}

type ProviderSearchInput = {
  readonly provider: Exclude<WebSearchProvider, "none">;
  readonly query: string;
  readonly apiKey: string;
  readonly maxResults: number;
  readonly fetch: FetchLike;
  readonly signal?: AbortSignal;
  readonly options: WebSearchToolOptions;
};

function providerFailed(input: ProviderSearchInput, status: number): WebSearchToolOutput {
  return {
    provider: input.provider,
    status: "provider_failed",
    searched: true,
    query: input.query,
    results: [],
    message: `${providerLabel(input.provider)} search returned HTTP ${status}.`,
  };
}

function queryFromInput(input: unknown): string | undefined {
  const record = asOptionalRecord(input);
  const value = record?.query;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resultsFromTavily(raw: unknown): WebSearchToolOutput["results"] {
  const record = asOptionalRecord(raw);
  const results = Array.isArray(record?.results) ? record.results : [];
  return results.map((item) => {
    const result = asOptionalRecord(item);
    return compactSearchResult({
      title: stringOrFallback(result?.title, "Untitled result"),
      url: stringOrFallback(result?.url, ""),
      snippet: stringOrFallback(result?.content ?? result?.snippet, ""),
      source: stringOrUndefined(result?.source),
    });
  });
}

function resultsFromExa(raw: unknown): WebSearchToolOutput["results"] {
  const record = asOptionalRecord(raw);
  const results = Array.isArray(record?.results) ? record.results : [];
  return results.map((item) => {
    const result = asOptionalRecord(item);
    const highlights = Array.isArray(result?.highlights)
      ? result.highlights.filter((highlight): highlight is string => typeof highlight === "string").join(" ")
      : undefined;
    return compactSearchResult({
      title: stringOrFallback(result?.title, "Untitled result"),
      url: stringOrFallback(result?.url, ""),
      snippet: stringOrFallback(highlights ?? result?.text ?? result?.summary, ""),
      publishedAt: stringOrUndefined(result?.publishedDate ?? result?.published_at),
    });
  });
}

function resultsFromZai(raw: unknown): WebSearchToolOutput["results"] {
  const record = asOptionalRecord(raw);
  const results = Array.isArray(record?.search_result) ? record.search_result : [];
  return results.map((item) => {
    const result = asOptionalRecord(item);
    return compactSearchResult({
      title: stringOrFallback(result?.title, "Untitled result"),
      url: stringOrFallback(result?.link, ""),
      snippet: stringOrFallback(result?.content, ""),
      source: stringOrUndefined(result?.media),
      publishedAt: stringOrUndefined(result?.publish_date),
    });
  });
}

function resultsFromMetaso(raw: unknown): WebSearchToolOutput["results"] {
  const record = asOptionalRecord(raw);
  const data = asOptionalRecord(record?.data) ?? record;
  const directResults = firstArray(data?.webpages, data?.results, data?.references, data?.searchResults);
  if (directResults.length > 0) {
    return directResults.map((item, index) => metasoReferenceResult(item, index));
  }
  return [];
}

function metasoReferenceResult(item: unknown, index: number): WebSearchToolOutput["results"][number] {
  const result = asOptionalRecord(item);
  const title = stringOrFallback(
    result?.title ?? result?.name ?? result?.siteName ?? result?.source,
    `秘塔搜索结果 ${index + 1}`
  );
  const url = stringOrFallback(result?.url ?? result?.link ?? result?.href ?? result?.originUrl, "");
  const snippet = stringOrFallback(
    result?.snippet ?? result?.summary ?? result?.content ?? result?.text ?? result?.description,
    ""
  );
  return compactSearchResult({
    title,
    url,
    snippet,
    source: stringOrUndefined(result?.source ?? result?.siteName ?? result?.media),
    publishedAt: stringOrUndefined(result?.publishedAt ?? result?.publishTime ?? result?.date),
  });
}

function resultsFromGoogle(raw: unknown): WebSearchToolOutput["results"] {
  const record = asOptionalRecord(raw);
  const results = Array.isArray(record?.items) ? record.items : [];
  return results.map((item) => {
    const result = asOptionalRecord(item);
    return compactSearchResult({
      title: stringOrFallback(result?.title, "Untitled result"),
      url: stringOrFallback(result?.link, ""),
      snippet: stringOrFallback(result?.snippet, ""),
      source: stringOrUndefined(result?.displayLink),
      publishedAt: publishedAtFromGoogleResult(result),
    });
  });
}

function resultsFromBing(raw: unknown): WebSearchToolOutput["results"] {
  const record = asOptionalRecord(raw);
  const webPages = asOptionalRecord(record?.webPages);
  const results = Array.isArray(webPages?.value) ? webPages.value : [];
  return results.map((item) => {
    const result = asOptionalRecord(item);
    return compactSearchResult({
      title: stringOrFallback(result?.name, "Untitled result"),
      url: stringOrFallback(result?.url, ""),
      snippet: stringOrFallback(result?.snippet, ""),
      publishedAt: stringOrUndefined(result?.dateLastCrawled),
    });
  });
}

function compactSearchResult(input: {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly source?: string;
  readonly publishedAt?: string;
}): WebSearchToolOutput["results"][number] {
  return {
    title: input.title,
    url: input.url,
    snippet: input.snippet,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.publishedAt === undefined ? {} : { publishedAt: input.publishedAt }),
  };
}

function resolveGlobalFetch(): FetchLike | undefined {
  const fetchImpl = (globalThis as { fetch?: FetchLike }).fetch;
  return typeof fetchImpl === "function" ? fetchImpl : undefined;
}

function normalizeProvider(value: WebSearchProvider | undefined): WebSearchProvider {
  if (
    value === "none" ||
    value === "tavily" ||
    value === "exa" ||
    value === "zai" ||
    value === "metaso" ||
    value === "google" ||
    value === "bing"
  ) {
    return value;
  }
  return "tavily";
}

function requiredProviderConfigurationMissing(
  provider: WebSearchProvider,
  options: WebSearchToolOptions
): string | undefined {
  if (provider === "google" && normalizeOptionalString(options.googleEngineId) === undefined) {
    return "Google Custom Search requires a Programmable Search Engine ID.";
  }
  return undefined;
}

function maxResultsForProvider(provider: Exclude<WebSearchProvider, "none">, value: number | undefined): number {
  const requested = Math.max(1, Math.floor(value ?? DEFAULT_MAX_RESULTS));
  if (provider === "google") {
    return Math.min(10, requested);
  }
  if (provider === "tavily") {
    return Math.min(20, requested);
  }
  if (provider === "zai" || provider === "metaso" || provider === "bing") {
    return Math.min(50, requested);
  }
  return Math.min(100, requested);
}

function providerLabel(provider: WebSearchProvider): string {
  if (provider === "exa") return "Exa";
  if (provider === "zai") return "Z.AI";
  if (provider === "metaso") return "秘塔搜索";
  if (provider === "google") return "Google Custom Search";
  if (provider === "bing") return "Bing Web Search";
  if (provider === "none") return "configured";
  return "Tavily";
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value.trim() : undefined;
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}


function firstArray(...values: readonly unknown[]): readonly unknown[] {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}


function publishedAtFromGoogleResult(result: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const pageMap = asOptionalRecord(result?.pagemap);
  const metatags = Array.isArray(pageMap?.metatags) ? pageMap.metatags : [];
  for (const item of metatags) {
    const tag = asOptionalRecord(item);
    const value = stringOrUndefined(tag?.["article:published_time"] ?? tag?.["date"] ?? tag?.["datepublished"]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}
