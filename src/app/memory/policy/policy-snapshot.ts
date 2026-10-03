import type { MemoryOwner } from "../../../domain/memory/index.js";
import type {
  EffectiveMemoryAdmission,
  MemoryRolloutMode,
} from "../contracts.js";
import { ADMISSION_REASON, resolveEffectiveMemoryAdmission } from "./effective-admission.js";
import type {
  MemoryLifecycleRow,
  MemoryPolicyRow,
} from "../store/persistence-schema.js";

/**
 * 持久化 policy 行 → 有效准入（ADR 0018）。
 *
 * 只有两条 policy：`consent:global`（用户唯一开关）与 `rollout:global`
 * （开发者 rollout）。没有 per-owner participation：所有 Space 同源，
 * 一律由同一个 enabled 总开关控制。
 */
export const POLICY_KEY = {
  consent: "consent:global",
  rollout: "rollout:global",
} as const;

const FENCED_STATES = new Set(["fenced", "tombstone"]);

export type ResolveAdmissionFromPolicyInput = {
  readonly owner: MemoryOwner;
  readonly conversationId: string;
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
  const byKey = new Map(input.policyRows.map((row) => [row.key, row]));

  const consentRow = byKey.get(POLICY_KEY.consent);
  const rolloutRow = byKey.get(POLICY_KEY.rollout);

  const enabled = consentRow?.enabled ?? false;
  const rollout = rolloutFromRow(rolloutRow);

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
    `gen${generation}`;
  const rolloutRevision = `r${rolloutRow?.revision ?? 0}`;

  return resolveEffectiveMemoryAdmission({
    scopeKind: input.owner.kind,
    enabled,
    rollout,
    fenced,
    generation,
    policyRevision,
    rolloutRevision,
  });
}

export { ADMISSION_REASON };
