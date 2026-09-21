import type { ConfigCenter } from "../../config-center/index.js";
import type { ResearchSearchPort } from "../../application/research-application.js";
import { searchWithWebProvider, type FetchLike } from "../../tool-center/adapters/web-search-tool.js";

/**
 * 深度研究的检索适配器（Host 组合根装配）。
 *
 * 复用 WebSearch 的 provider 实现与同一份运行时配置（ConfigCenter 解析），
 * 不另建第二个搜索适配器。provider 为 `model_builtin` 时不产生运行时配置——
 * 那种模式下的联网由模型侧自带，不属于本产品的可审计检索，因此如实不可用，
 * 而不是悄悄返回空结果冒充成功。
 */

const RESEARCH_SEARCH_MAX_RESULTS = 8;

export type ResearchSearchReadiness = { readonly available: boolean; readonly reason?: string };

export function createConfigCenterResearchSearch(input: {
  readonly configCenter: ConfigCenter;
  readonly fetch?: FetchLike;
}): { readonly port: ResearchSearchPort; readonly readiness: () => Promise<ResearchSearchReadiness> } {
  const readiness = async (): Promise<ResearchSearchReadiness> => {
    const config = await input.configCenter.resolveWebSearchRuntimeConfig();
    if (config === undefined) {
      return { available: false, reason: "web_search_not_configured" };
    }
    return { available: true };
  };

  return {
    readiness,
    port: {
      async search(request) {
        const config = await input.configCenter.resolveWebSearchRuntimeConfig();
        if (config === undefined) return { status: "failed", code: "web_search_not_configured" };
        const output = await searchWithWebProvider({
          config,
          query: request.query,
          maxResults: Math.max(1, Math.min(request.limit, RESEARCH_SEARCH_MAX_RESULTS)),
          ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
          signal: request.signal,
        });
        if (output.status !== "completed") {
          return { status: "failed", code: output.status === "invalid_input" ? "invalid_query" : "search_provider_failed" };
        }
        const results = output.results
          .map((item) => ({
            title: item.title,
            url: item.url,
            snippet: item.snippet,
            ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
          }))
          .filter((item) => item.url.length > 0);
        return { status: "completed", results };
      },
    },
  };
}
