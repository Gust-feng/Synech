/**
 * Policy Gate：有效记忆准入的唯一纯函数（《手册》7.1 / 12.2，ADR 政策分账）。
 *
 * 同一函数贯穿四个边界（capture 接受 / 模型结果提交 / recall 返回 / injection
 * freeze），每次在各自边界重新计算，不缓存陈旧结论。
 *
 * 有效策略优先级（任一更具体范围拒绝即 effective off）：
 *   lifecycle fence（删除/清除进行中，最高）
 *   > global consent
 *   > Space participation（Workspace scope 不参与自动记忆）
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
  /** 当前 Space 是否 opt-in；global scope 下忽略，Workspace scope 恒为 false。 */
  readonly spaceParticipation: boolean;
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
  globalConsent: "global_consent",
  spaceParticipation: "space_participation",
  rolloutOff: "rollout_off",
} as const;

export function resolveEffectiveMemoryAdmission(
  input: EffectiveAdmissionInput,
): EffectiveMemoryAdmission {
  const reasons: string[] = [];
  // 收集全部命中原因（不短路），便于 Developer Diagnostics 解释；任一命中即 off。
  if (input.fenced) reasons.push(ADMISSION_REASON.generationFence);
  if (!input.globalConsent) reasons.push(ADMISSION_REASON.globalConsent);
  if (input.scopeKind === "workspace" || (input.scopeKind === "space" && !input.spaceParticipation)) {
    reasons.push(ADMISSION_REASON.spaceParticipation);
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
