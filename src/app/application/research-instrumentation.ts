import { getEncoding, type Tiktoken } from "js-tiktoken";

import type { ResearchContextProjectionUsagePayload } from "../research/contracts.js";

/**
 * 研究执行的评估插桩（S7：只埋点不调参）。
 *
 * RESEARCH_POLICY 的 constrained 墙钟比例、finalization reserve、抽样比例与问题数
 * 区间都是首版保守值，Phase 4 要用本项目实测数据标定；标定的前提是先有测量。
 * 本模块只生产测量与落账形状，不参与任何研究决策：
 *
 * - token 计数用固定通用编码（js-tiktoken o200k_base）：研究不绑定单一 provider，
 *   计数是**带身份的近似测量**，不是计费事实（tokenizer.exactMatch 如实为 false）；
 * - 每轮投影测量经 ledger_change 动作事件落账，进入用户可见用量区，**永不进入
 *   模型上下文**——投影器 never_enter.usage_totals 等注册项不受插桩影响；
 * - 纯函数：同文本同计数，无时钟、无随机、无外部读取。
 */

/** token 计数身份：随每次测量落账，Phase 4 据此解释历史数据。 */
export type ResearchProjectionTokenizer = {
  readonly source: string;
  readonly encoding: string;
  /** 固定通用编码与用户实际模型不保证逐 token 一致：如实记为 false。 */
  readonly exactMatch: boolean;
};

export const RESEARCH_PROJECTION_TOKENIZER: ResearchProjectionTokenizer = {
  source: "js_tiktoken",
  encoding: "o200k_base",
  exactMatch: false,
};

let sharedEncoding: Tiktoken | undefined;

function encoding(): Tiktoken {
  sharedEncoding ??= getEncoding("o200k_base");
  return sharedEncoding;
}

/** 文本 token 数（确定性测量）。 */
export function countResearchProjectionTokens(text: string): number {
  return encoding().encode(text).length;
}

/**
 * 一次投影的测量 → 落账负载（结构字段负责程序分支；展示层不得从文案反推数字）。
 *
 * turn 序号与 projectorVersion 让每条测量可 join 投影器版本与轨迹；
 * slotsIncluded 是本次实际装配的槽位数（never_enter 恒为 false，不计入）。
 */
export function researchProjectionUsagePayload(input: {
  readonly turn: number;
  readonly projectorVersion: string;
  readonly instructions: string;
  readonly stateMessage: string;
  readonly slotsIncluded: number;
}): ResearchContextProjectionUsagePayload {
  const instructionTokens = countResearchProjectionTokens(input.instructions);
  const stateTokens = countResearchProjectionTokens(input.stateMessage);
  return {
    version: 1,
    entity: "context_projection",
    change: "turn_projection",
    turn: input.turn,
    projectorVersion: input.projectorVersion,
    tokenizer: RESEARCH_PROJECTION_TOKENIZER,
    instructionTokens,
    stateTokens,
    totalTokens: instructionTokens + stateTokens,
    slotsIncluded: input.slotsIncluded,
  };
}

/**
 * 确定性硬门拒绝的结构化失败码（发布判定的用户可见事实）。
 *
 * 零保留来源与解析契约失败都有稳定兜底码；拒绝时 task 终态只带 errorCode，
 * 失败码清单经 ledger_change 事件落账（`report` / `gate_rejected`）——
 * 结构事实不塞进展示文案，读取方也不从 message 反推。
 */
export function researchGateFailureCodes(
  codes: readonly string[],
): readonly string[] {
  const unique = [...new Set(codes)];
  return unique.length > 0 ? unique : ["model_output_invalid"];
}
