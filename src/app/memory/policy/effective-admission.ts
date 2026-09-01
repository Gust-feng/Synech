/**
 * Policy Gate：有效记忆准入的唯一纯函数（《手册》7.1 / 12.2，ADR 政策分账）。
 *
 * 同一函数贯穿四个边界（capture 接受 / 模型结果提交 / recall 返回 / injection
 * freeze），每次在各自边界重新计算，不缓存陈旧结论。
 *
 * 有效策略优先级（任一更具体范围拒绝即 effective off）：
 *   lifecycle fence（删除/清除进行中，最高）
 *   > 本轮 override（不用）
 *   > Conversation exclusion
 *   > global consent
 *   > Space/Workspace participation（global scope 无此项）
 *   > rollout 总开关
 * Developer Shadow 不得越过任何用户选择；rollout 只在用户选择全部允许时才生效。
 */

import type {
  EffectiveMemoryAdmission,
  MemoryRolloutMode,
  PolicyRevision,
} from "../contracts.js";

export type EffectiveAdmissionInput = {
  readonly scopeKind: "global" | "space" | "workspace";
  readonly globalConsent: boolean;
  /** Space/Workspace 是否 opt-in；global scope 下忽略。 */
  readonly scopeParticipation: boolean;
  /** 该 Conversation 是否被用户排除。 */
  readonly conversationExcluded: boolean;
  /** 本轮"不用记忆"（Ordinary 冻结 Run 输入携带）。 */
  readonly turnOverrideOff: boolean;
  readonly rollout: MemoryRolloutMode;
  /** lifecycle fence 已立（owner/conversation 删除或清除进行中）。 */
  readonly fenced: boolean;
  readonly generation: number;
  readonly policyRevision: PolicyRevision;
  readonly rolloutRevision: string;
};

/** 结构原因码（程序分支用，非展示文案）。 */
export const ADMISSION_REASON = {
  generationFence: "generation_fence",
  turnOverride: "turn_override",
  conversationExclusion: "conversation_exclusion",
  globalConsent: "global_consent",
  scopeParticipation: "scope_participation",
  rolloutOff: "rollout_off",
} as const;

export function resolveEffectiveMemoryAdmission(
  input: EffectiveAdmissionInput,
): EffectiveMemoryAdmission {
  const reasons: string[] = [];
  // 收集全部命中原因（不短路），便于 Developer Diagnostics 解释；任一命中即 off。
  if (input.fenced) reasons.push(ADMISSION_REASON.generationFence);
  if (input.turnOverrideOff) reasons.push(ADMISSION_REASON.turnOverride);
  if (input.conversationExcluded) reasons.push(ADMISSION_REASON.conversationExclusion);
  if (!input.globalConsent) reasons.push(ADMISSION_REASON.globalConsent);
  if (input.scopeKind !== "global" && !input.scopeParticipation) {
    reasons.push(ADMISSION_REASON.scopeParticipation);
  }
  if (input.rollout === "off") reasons.push(ADMISSION_REASON.rolloutOff);

  const effective = reasons.length === 0 ? input.rollout : "off";
  return {
    effective: effective as EffectiveMemoryAdmission["effective"],
    policyRevision: input.policyRevision,
    rolloutRevision: input.rolloutRevision,
    generation: input.generation,
    reasons,
  };
}
