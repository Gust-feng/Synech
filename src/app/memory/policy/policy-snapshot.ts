/**
 * Policy Snapshot：把持久化的 policy 行 + lifecycle 行还原成一次边界计算所需的
 * EffectiveAdmissionInput，并复用唯一纯函数 resolveEffectiveMemoryAdmission。
 *
 * 这是「持久化策略 → 有效准入」的唯一组装点：四个边界（capture / 提交 / recall /
 * injection freeze）都必须先经此处得到当次新鲜结论，不缓存（《手册》7.1）。
 *
 * policy 行编码约定（memory_policy 表只有 enabled 布尔，三态 rollout 借 scope_owner_key
 * 存模式；后续 MemoryAdminApplication 必须按本文件常量写同一套 key）：
 * - global consent：      kind=global_consent,           key=POLICY_KEY.consent,   enabled=同意
 * - rollout 模式：        kind=rollout,                  key=POLICY_KEY.rollout,   scope_owner_key='shadow'|'active', enabled=1
 * - scope participation： kind=scope_participation,      key=`participation:${ownerKey}`, enabled=参与
 * - conversation 排除：   kind=conversation_exclusion,   key=`exclusion:conversation:${conversationId}`, enabled=已排除
 * 无对应行即安全默认：未同意 / rollout=off / 未参与 / 未排除（fail-closed，Opt-in MVP）。
 */

import { memoryOwnerKey, type MemoryOwner } from "../../../domain/memory/index.js";
import type {
  EffectiveMemoryAdmission,
  MemoryRolloutMode,
} from "../contracts.js";
import {
  ADMISSION_REASON,
  resolveEffectiveMemoryAdmission,
} from "./effective-admission.js";
import type {
  MemoryLifecycleRow,
  MemoryPolicyRow,
} from "../store/persistence-schema.js";

export const POLICY_KEY = {
  consent: "consent:global",
  rollout: "rollout:global",
} as const;

export function participationKey(ownerKey: string): string {
  return `participation:${ownerKey}`;
}

export function conversationExclusionKey(conversationId: string): string {
  return `exclusion:conversation:${conversationId}`;
}

const FENCED_STATES = new Set(["fenced", "tombstone"]);

export type ResolveAdmissionFromPolicyInput = {
  readonly owner: MemoryOwner;
  readonly conversationId: string;
  /** 本轮"不用记忆"覆盖（Ordinary 冻结 Run 输入携带）。 */
  readonly turnOverrideOff: boolean;
  readonly policyRows: readonly MemoryPolicyRow[];
  readonly ownerLifecycle: MemoryLifecycleRow | undefined;
  readonly conversationLifecycle: MemoryLifecycleRow | undefined;
};

function rolloutFromRow(row: MemoryPolicyRow | undefined): MemoryRolloutMode {
  if (row === undefined || !row.enabled) return "off";
  const mode = row.scopeOwnerKey;
  return mode === "shadow" || mode === "active" ? mode : "off";
}

export function resolveAdmissionFromPolicy(
  input: ResolveAdmissionFromPolicyInput,
): EffectiveMemoryAdmission {
  const ownerKey = memoryOwnerKey(input.owner);
  const byKey = new Map(input.policyRows.map((row) => [row.key, row]));

  const consentRow = byKey.get(POLICY_KEY.consent);
  const rolloutRow = byKey.get(POLICY_KEY.rollout);
  const participationRow = byKey.get(participationKey(ownerKey));
  const exclusionRow = byKey.get(conversationExclusionKey(input.conversationId));

  const globalConsent = consentRow?.enabled ?? false;
  const rollout = rolloutFromRow(rolloutRow);
  const scopeParticipation = participationRow?.enabled ?? false;
  const conversationExcluded = exclusionRow?.enabled === true;

  const ownerFenced =
    input.ownerLifecycle !== undefined && FENCED_STATES.has(input.ownerLifecycle.fenceState);
  const conversationFenced =
    input.conversationLifecycle !== undefined &&
    FENCED_STATES.has(input.conversationLifecycle.fenceState);
  const fenced = ownerFenced || conversationFenced;
  const generation = input.ownerLifecycle?.generation ?? 0;

  // 权威 revision 确定性拼接，任一权威事实变化都会使旧结论失效。
  const policyRevision =
    `g${consentRow?.revision ?? 0}:` +
    `r${rolloutRow?.revision ?? 0}:` +
    `s${participationRow?.revision ?? 0}:` +
    `c${exclusionRow?.revision ?? 0}:` +
    `gen${generation}`;
  const rolloutRevision = `r${rolloutRow?.revision ?? 0}`;

  return resolveEffectiveMemoryAdmission({
    scopeKind: input.owner.kind,
    globalConsent,
    scopeParticipation,
    conversationExcluded,
    turnOverrideOff: input.turnOverrideOff,
    rollout,
    fenced,
    generation,
    policyRevision,
    rolloutRevision,
  });
}

export { ADMISSION_REASON };
