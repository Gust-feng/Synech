import type { SpaceMemoryBackground } from "../contracts.js";

/**
 * Space 长期记忆背景的模型可见渲染（正式设计 §9.2）。
 *
 * - 头部声明 advisory 性质：历史背景、可能过时、让位于当前请求与可验证事实；
 * - header 展示本版更新时间与来源（模型整理/用户编辑）——时间戳与来源标签属于
 *   背景数据，不是工程控制指令；
 * - 正文按发布原文渲染，不做二次改写；空正文（修订后无内容）不注入。
 */

export const MEMORY_BACKGROUND_HEADER = "[Space memory — historical background]";

export function renderMemoryBackgroundBlock(background: SpaceMemoryBackground): string {
  if (background.markdown.trim().length === 0) return "";
  const originLabel = background.origin === "user_edit" ? "user-edited" : "model-curated";
  const updatedAt = new Date(background.updatedAt).toISOString();
  return [
    MEMORY_BACKGROUND_HEADER,
    `(updated ${updatedAt} · ${originLabel} · advisory background, may be outdated; current requests and verifiable facts take precedence)`,
    "",
    background.markdown,
  ].join("\n");
}
