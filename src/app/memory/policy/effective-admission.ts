import type {
  EffectiveMemoryAdmission,
  MemoryRolloutMode,
  PolicyRevision,
} from "../contracts.js";

/**
 * Policy Gate：有效记忆准入的唯一纯函数（准入政策与 Core 分账，见架构决策记录）。
 *
 * 同一函数贯穿四个边界（capture 接受 / 模型结果提交 / recall 返回 / injection
 * freeze），每次在各自边界重新计算，不缓存陈旧结论。
 *
 * 有效策略优先级（任一更具体范围拒绝即 effective off）：
 *   lifecycle fence（删除/清除进行中，最高）
 *   > 全局 enabled 总开关（唯一用户可见开关，默认关闭）
 *   > rollout 总开关
 * Space owners 只受同一个 enabled 总开关控制，不存在
 * 逐 owner opt-in，也不存在跨 owner 的自动学习。
 * Developer Shadow 不得越过用户选择；rollout 只在用户开启后才可能生效。
 */

export type EffectiveAdmissionInput = {
  readonly scopeKind: "global" | "space" | "workspace";
  /** 全局记忆总开关（用户唯一可见开关；默认关闭）。 */
  readonly enabled: boolean;
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
  disabled: "memory_disabled",
  rolloutOff: "rollout_off",
} as const;

export function resolveEffectiveMemoryAdmission(
  input: EffectiveAdmissionInput,
): EffectiveMemoryAdmission {
  const reasons: string[] = [];
  // 收集全部命中原因（不短路），便于 Developer Diagnostics 解释；任一命中即 off。
  if (input.fenced) reasons.push(ADMISSION_REASON.generationFence);
  if (!input.enabled) reasons.push(ADMISSION_REASON.disabled);
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
