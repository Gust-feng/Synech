/**
 * 报告成稿子系统（M9 纯库切片，S5w 接线）：
 * 写作提示词构建器 / ReportSpan 解析 / 确定性 MD 渲染器 / 确定性硬门 /
 * 语义抽样核验 / MD 导出。本目录不导入 application/、不调 finishTask，
 * 只读 ../contracts.js 的 S1 契约形状。
 */
export * from "./contracts.js";
export * from "./prompt.js";
export * from "./spans.js";
export * from "./gate.js";
export * from "./render.js";
export * from "./sample.js";
export * from "./compose.js";
export * from "./export.js";
