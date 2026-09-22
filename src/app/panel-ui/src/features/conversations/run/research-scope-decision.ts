import type { ResearchScopeCardState } from "./research-scope-card";
import type { ResearchScopeGateFailureView } from "@panel-api/research";

/**
 * 用户对范围卡的决定（ADR 0001 §2.2 / D3）。
 *
 * 与 `decideRunConfirmation` 同一形态的用户决定模式：卡片点击产生携带 payload 的
 * 用户命令，由 Route 解析后调用同一个 `ResearchApplication.start`。
 * - `approve`：携带该 payload 启动研究；范围卡是唯一启动路径；
 * - `reject`：保留提案但标记已处理，回到对话继续澄清（不启动、不写任何研究事实）。
 */
export type ResearchScopeDecision =
  | { readonly kind: "approve"; readonly state: ResearchScopeCardState }
  | { readonly kind: "reject"; readonly proposalKey: string };

export type ResearchScopeDecisionResult = {
  /** 是否已启动（approve 且 start 成功）。 */
  readonly started: boolean;
  /** 范围门拒绝时的结构化缺失字段清单；随拒绝原样带回，不本地补全。 */
  readonly missing: readonly ResearchScopeGateFailureView[] | null;
  /** 展示用失败原因；结构化缺失清单优先于它。 */
  readonly error?: string;
};
