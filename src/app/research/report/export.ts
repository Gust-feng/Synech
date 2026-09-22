import { writeFile } from "node:fs/promises";

import type { ResearchReportComposition } from "./contracts.js";

/**
 * MD 导出=写文件（ADR 0001 §2.5）：MD 是报告的原生形态，导出就是把同一份
 * Markdown 落盘，不存在第二套渲染器，因此导出保真由「只写硬门通过后的
 * markdown」保证——界面所见即文件所得。
 *
 * 拒绝路径：硬门未过或没有 markdown 时返回结构化拒绝，不写任何文件
 * （不生成「差一点就发布」的报告，更不能把它导出给用户）。
 * 文件系统错误如实上抛：未知错误不伪装成拒绝。
 */
export type ResearchReportExportResult =
  | { readonly ok: true; readonly filePath: string; readonly bytes: number }
  | {
    readonly ok: false;
    readonly reason: "gate_rejected" | "markdown_missing";
    readonly message: string;
  };

export async function exportResearchReportMarkdown(input: {
  readonly composition: ResearchReportComposition;
  readonly filePath: string;
}): Promise<ResearchReportExportResult> {
  const { composition, filePath } = input;
  if (!composition.gate.ok) {
    return { ok: false, reason: "gate_rejected", message: "报告未通过确定性硬门，不得导出。" };
  }
  if (composition.markdown === null) {
    return { ok: false, reason: "markdown_missing", message: "报告没有可导出的 Markdown 正文。" };
  }
  await writeFile(filePath, composition.markdown, "utf8");
  return { ok: true, filePath, bytes: Buffer.byteLength(composition.markdown, "utf8") };
}
