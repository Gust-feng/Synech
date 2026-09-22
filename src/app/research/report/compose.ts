import type { ResearchLedger } from "../contracts.js";
import { evaluateResearchReportGate } from "./gate.js";
import { parseResearchReportModelOutput } from "./spans.js";
import { renderResearchReportMarkdown } from "./render.js";
import { buildResearchCitationSample, readResearchCitationSupportRate } from "./sample.js";
import type {
  ResearchCitationSample,
  ResearchCitationSupportRate,
  ResearchCitationVerdictInput,
  ResearchReportComposition,
  ResearchReportDraft,
  ResearchReportGateResult,
} from "./contracts.js";

/**
 * 库输出契约为 {title, spans, markdown, gate, supportRate} 的唯一装配点：
 * 解析（模型输出契约）→ 硬门（账本事实核验）→ 渲染（仅硬门通过时）→ 抽样支撑率
 * （verdicts 到达后由调用方回填，本片不调模型）。
 *
 * 零接线：不调 finishTask、不碰 application/；持久化由 S5w 用
 * toResearchReportSpanDrafts(spans) 转成 S1 草稿后经既有命令写入。
 */

export type ResearchReportComposeInput = {
  readonly ledger: ResearchLedger;
  readonly modelOutput: unknown;
  /** verifier 五值判定；缺省不产出支撑率（本切片不调 verifier 模型）。 */
  readonly verdicts?: readonly ResearchCitationVerdictInput[];
  /** 抽样问题数；缺省 RESEARCH_POLICY.citationSampleQuestionsPerTask。 */
  readonly questionsPerTask?: number;
};

export function composeResearchReport(input: ResearchReportComposeInput): ResearchReportComposition {
  const parse = parseResearchReportModelOutput(input.modelOutput);
  if (!parse.ok) {
    return {
      ok: false,
      title: null,
      spans: [],
      markdown: null,
      gate: {
        ok: false,
        failures: [{
          code: "model_output_invalid",
          spanOrdinal: null,
          field: "spans",
          message: "模型输出未通过结构解析，不得发布；细节见 composition.parse.failures。",
        }],
      },
      supportRate: null,
      parse,
    };
  }

  const draft = parse.draft;
  const gate: ResearchReportGateResult = evaluateResearchReportGate({ ledger: input.ledger, draft });
  // 硬门不过即不生成 Markdown：不存在「差一点就发布」的报告。
  const markdown = gate.ok ? renderResearchReportMarkdown({ draft, ledger: input.ledger }) : null;
  const supportRate = readSupportRate(input.ledger, draft, input.verdicts, input.questionsPerTask);

  return {
    ok: gate.ok,
    title: draft.title,
    spans: draft.spans,
    markdown,
    gate,
    supportRate,
    parse,
  };
}

/** 抽样核验不阻断发布：硬门拒绝时也照常测量（有 verdicts 才产出）。 */
function readSupportRate(
  ledger: ResearchLedger,
  draft: ResearchReportDraft,
  verdicts: readonly ResearchCitationVerdictInput[] | undefined,
  questionsPerTask: number | undefined,
): ResearchCitationSupportRate | null {
  if (verdicts === undefined || verdicts.length === 0) return null;
  const sample: ResearchCitationSample = buildResearchCitationSample({ ledger, draft, questionsPerTask });
  return readResearchCitationSupportRate({ sample, verdicts });
}
