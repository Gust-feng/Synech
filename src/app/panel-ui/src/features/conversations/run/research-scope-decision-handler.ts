import type { AppState } from "../../../workbench/state";
import {
  researchStartPayloadFromProposal,
  submitResearchScope,
  ResearchScopeRejected,
} from "./research-scope-card";
import type {
  ResearchScopeDecision,
  ResearchScopeDecisionResult,
} from "./research-scope-decision";

/**
 * 范围卡的用户决定执行（主会话内，ADR 0001 §2.2 / D3）。
 *
 * 与 `decideRunConfirmation` 同构：单一在途（busy 门）、成功后重读权威快照、
 * 失败如实带回缺失字段清单。这里不编排研究执行：启动只是把用户批准的载荷
 * 交给同一个 Application command，worker 自行认领。
 */
export async function decideResearchScope(input: {
  readonly decision: ResearchScopeDecision;
  readonly conversationId: string | undefined;
  readonly researchScopeBusy: boolean;
  readonly setResearchScopeBusy: (busy: boolean) => void;
  readonly setApp: (update: (previous: AppState) => AppState) => void;
  readonly refreshConversations: () => Promise<void>;
  readonly now?: () => number;
}): Promise<ResearchScopeDecisionResult> {
  if (input.researchScopeBusy) return { started: false, missing: null };
  const decision = input.decision;

  if (decision.kind === "reject") {
    input.setApp((previous) => ({
      ...previous,
      settledResearchScopeKeys: [...previous.settledResearchScopeKeys, decision.proposalKey],
      error: undefined,
    }));
    return { started: false, missing: null };
  }

  if (input.conversationId === undefined) {
    return {
      started: false,
      missing: null,
      error: "范围卡需要挂在一个会话上才能批准：请先打开发起澄清的对话。",
    };
  }

  input.setResearchScopeBusy(true);
  input.setApp((previous) => ({ ...previous, error: undefined }));
  try {
    const payload = researchStartPayloadFromProposal(decision.state, {
      conversationRef: input.conversationId,
      approvedAt: input.now?.() ?? Date.now(),
    });
    await submitResearchScope(payload);
    input.setApp((previous) => ({
      ...previous,
      settledResearchScopeKeys: [...previous.settledResearchScopeKeys, decision.state.proposalKey],
    }));
    // 权威快照在研究视图侧刷新；会话侧只刷新列表摘要，不本地拼接任何研究事实。
    await input.refreshConversations();
    return { started: true, missing: null };
  } catch (error) {
    if (error instanceof ResearchScopeRejected) {
      // 结构校验门拒绝：卡片继续显示，并把结构化缺失字段清单带回对话侧追问。
      return { started: false, missing: error.failures, error: error.message };
    }
    return {
      started: false,
      missing: null,
      error: error instanceof Error ? error.message : "启动研究失败，请重试。",
    };
  } finally {
    input.setResearchScopeBusy(false);
  }
}
