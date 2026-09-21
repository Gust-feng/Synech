import type { ResearchContentPort } from "../../application/research-application.js";
import type { BrowserAutomation } from "../../tool-center/adapters/browser-tool.js";
import { fetchPageSnapshot } from "../../tool-center/adapters/browser-tool.js";

/**
 * 深度研究的正文抓取适配器（Host 组合根装配）。
 *
 * 复用 WebFetch 的同一套浏览器能力（隔离会话、投递前取消检查、失败即失败）。
 * 抓取失败不抛给编排：来源退化为摘要证据，报告在「缺口与限制」中如实反映。
 *
 * 空文本与极短文本按失败处理——很多站点在无脚本环境下只返回导航壳，
 * 把它当正文会让报告引用一段没有信息量的内容。
 */

/** 低于该长度的快照不作为正文证据（通常是登录墙、脚本壳或纯导航）。 */
const MIN_CONTENT_CHARS = 200;

export function createResearchContentFetcher(input: {
  readonly automation?: BrowserAutomation;
  readonly waitMs?: number;
}): ResearchContentPort {
  return {
    async fetch(request) {
      try {
        const snapshot = await fetchPageSnapshot({
          url: request.url,
          ...(input.waitMs === undefined ? {} : { waitMs: input.waitMs }),
          ...(input.automation === undefined ? {} : { automation: input.automation }),
          signal: request.signal,
        });
        const text = (snapshot.text ?? "").replace(/\s+\n/g, "\n").trim();
        if (text.length < MIN_CONTENT_CHARS) return { status: "failed", code: "content_too_short" };
        return { status: "completed", text };
      } catch (error) {
        return {
          status: "failed",
          code: error instanceof Error && error.name === "AbortError" ? "content_fetch_cancelled" : "content_fetch_failed",
        };
      }
    },
  };
}
