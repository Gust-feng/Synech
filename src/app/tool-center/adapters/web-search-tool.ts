import { asOptionalRecord, stringOrUndefined } from "../../../kernel/values/index.js";
import type { WebSearchRuntimeConfig } from "../../../domain/config/index.js";
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

export type WebSearchProvider = WebSearchRuntimeConfig["provider"];

export type WebSearchToolOptions = WebSearchRuntimeConfig & {
  readonly fetch?: FetchLike;
};

export type WebSearchToolOutput = {
  readonly provider: WebSearchProvider;
  readonly status: "completed" | "invalid_input" | "provider_failed";
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
// 秘塔开放平台的检索接口。文档（https://metaso.cn/search-api/playground）标注为
// POST /api/v1/search：请求体用 `q` 传检索词，响应体是 { credits, searchParameters, webpages, total }。
// 成功响应不带 errCode；失败时 HTTP 仍是 200，错误在 errCode/errMsg 里（见 searchMetaso 的判定）。
const METASO_SEARCH_ENDPOINT = "https://metaso.cn/api/v1/search";
const GOOGLE_CUSTOM_SEARCH_ENDPOINT = "https://www.googleapis.com/customsearch/v1";
const BING_WEB_SEARCH_ENDPOINT = "https://api.bing.microsoft.com/v7.0/search";
const DEFAULT_MAX_RESULTS = 5;

/**
 * 窄出口：在工具执行外壳之外发起一次同源检索。
 *
 * 深度研究这类应用层编排需要「调一次已配置的搜索服务」，但不走工具调用
 * （没有确认、结果包络与可见性策略）。这里复用同一组 provider 实现与同一份
 * 运行时配置，不另建第二个搜索适配器，也不改变 WebSearch 工具的行为。
 */
export type WebProviderSearchInput = {
  readonly config: WebSearchRuntimeConfig;
  readonly query: string;
  readonly maxResults?: number;
  readonly fetch?: FetchLike;
  readonly signal?: AbortSignal;
};

export async function searchWithWebProvider(input: WebProviderSearchInput): Promise<WebSearchToolOutput> {
  const provider = input.config.provider;
  const query = input.query.trim();
  if (query.length === 0) {
    return {
      provider,
      status: "invalid_input",
      searched: false,
      query: "",
      results: [],
      message: "WebSearch requires a non-empty string query.",
    };
  }
  const fetchImpl = input.fetch ?? resolveGlobalFetch();
  const maxResults = input.maxResults === undefined
    ? maxResultsForProvider(provider, input.config.maxResults)
    : Math.max(1, Math.min(input.maxResults, maxResultsForProvider(provider, input.config.maxResults)));
  try {
    return await executeProviderSearch({
      provider,
      query,
      apiKey: input.config.apiKey,
      maxResults,
      fetch: fetchImpl,
      signal: input.signal,
      options: input.config,
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

export function createWebSearchTool(options: WebSearchToolOptions): ToolExecutor {
  return {
    definition: {
      name: "WebSearch",
      description: "Search the web for current information using the configured search provider.",
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
      provider: options.provider,
      status: "provider_failed",
      searched: false,
      query: "",
      results: [],
      message: "WebSearch was cancelled.",
    };
  }
  if (query === undefined) {
    return {
      provider: options.provider,
      status: "invalid_input",
      searched: false,
      query: "",
      results: [],
      message: "WebSearch requires a non-empty string query.",
    };
  }

  const fetchImpl = options.fetch ?? resolveGlobalFetch();
  const provider = options.provider;
  const maxResults = maxResultsForProvider(provider, options.maxResults);
  try {
    return await executeProviderSearch({
      provider,
      query,
      apiKey: options.apiKey,
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
  readonly provider: WebSearchProvider;
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
      search_depth: input.options.searchDepth ?? "basic",
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
      type: input.options.searchType ?? "auto",
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
      search_engine: input.options.searchEngine ?? "search-prime",
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
      // 秘塔的检索词字段是 q（不是 question），写错会拿到参数错误而不是检索结果。
      q: input.query,
      lang: "zh",
    }),
    signal: input.signal,
  });
  if (!response.ok) {
    return providerFailed(input, response.status);
  }
  const raw = await response.json();
  // 秘塔用 HTTP 200 承载业务错误（errCode/errMsg），HTTP 状态码本身是成功的。
  // 不识别它就会把「密钥无效」当成「检索成功但没有结果」——等于用空结果冒充成功。
  const metasoError = metasoErrorCode(raw);
  if (metasoError !== undefined) {
    return providerFailed(input, metasoError);
  }
  return {
    provider: input.provider,
    status: "completed",
    searched: true,
    query: input.query,
    results: resultsFromMetaso(raw).slice(0, input.maxResults),
  };
}

/** 读取秘塔业务错误码；0 或缺失表示没有业务错误。 */
function metasoErrorCode(raw: unknown): number | undefined {
  const record = asOptionalRecord(raw);
  const code = record?.errCode ?? record?.errcode ?? record?.code;
  if (typeof code !== "number" || code === 0) return undefined;
  return code;
}

async function searchGoogle(input: ProviderSearchInput): Promise<WebSearchToolOutput> {
  const url = new URL(input.options.endpoint ?? GOOGLE_CUSTOM_SEARCH_ENDPOINT);
  url.searchParams.set("key", input.apiKey);
  url.searchParams.set("cx", input.options.engineId ?? "");
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
  const market = normalizeOptionalString(input.options.market);
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
  readonly provider: WebSearchProvider;
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

function resolveGlobalFetch(): FetchLike {
  const fetchImpl = (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("WebSearch requires fetch support.");
  }
  return fetchImpl;
}

function maxResultsForProvider(provider: WebSearchProvider, value: number | undefined): number {
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
