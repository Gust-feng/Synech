import { memoryOwnerKey, type MemoryOwner } from "../../../domain/memory/index.js";
import type {
  EffectiveMemoryAdmission,
  MemoryRolloutMode,
} from "../contracts.js";
import { ADMISSION_REASON, resolveEffectiveMemoryAdmission } from "./effective-admission.js";
import type {
  MemoryLifecycleRow,
  MemoryPolicyRow,
} from "../store/persistence-schema.js";

export const POLICY_KEY = {
  consent: "consent:global",
  rollout: "rollout:global",
} as const;

export function spaceParticipationKey(spaceId: string): string {
  return `participation:${memoryOwnerKey({ kind: "space", id: spaceId })}`;
}

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
  const ownerKey = memoryOwnerKey(input.owner);
  const byKey = new Map(input.policyRows.map((row) => [row.key, row]));

  const consentRow = byKey.get(POLICY_KEY.consent);
  const rolloutRow = byKey.get(POLICY_KEY.rollout);
  const spaceParticipationRow = input.owner.kind === "space"
    ? byKey.get(spaceParticipationKey(input.owner.id))
    : undefined;

  const globalConsent = consentRow?.enabled ?? false;
  const rollout = rolloutFromRow(rolloutRow);
  const spaceParticipation = spaceParticipationRow?.enabled ?? false;

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
    `s${spaceParticipationRow?.revision ?? 0}:` +
    `gen${generation}`;
  const rolloutRevision = `r${rolloutRow?.revision ?? 0}`;

  return resolveEffectiveMemoryAdmission({
    scopeKind: input.owner.kind,
    globalConsent,
    spaceParticipation,
    rollout,
    fenced,
    generation,
    policyRevision,
    rolloutRevision,
  });
}

export { ADMISSION_REASON };
