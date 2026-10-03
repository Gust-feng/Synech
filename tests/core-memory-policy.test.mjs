import assert from "node:assert/strict";
import test from "node:test";

import { ADMISSION_REASON, resolveEffectiveMemoryAdmission } from "../dist/app/memory/composition.js";

/**
 * Policy Gate（ADR 0018）：用户只有全局 enabled 开关，Space 与 Workspace 同源，
 * 不存在逐 owner opt-in；deny 原因全部收集，任一命中即 off。
 */

function baseInput(overrides = {}) {
  return {
    scopeKind: "space",
    enabled: true,
    rollout: "active",
    fenced: false,
    generation: 1,
    policyRevision: "p1",
    rolloutRevision: "r1",
    ...overrides,
  };
}

test("all gates open: rollout passes through for Space and Workspace owners", () => {
  assert.equal(resolveEffectiveMemoryAdmission(baseInput()).effective, "active");
  assert.equal(resolveEffectiveMemoryAdmission(baseInput({ rollout: "shadow" })).effective, "shadow");
  assert.equal(resolveEffectiveMemoryAdmission(baseInput({ scopeKind: "workspace" })).effective, "active");
});

test("the global enabled switch is the only user gate", () => {
  const admission = resolveEffectiveMemoryAdmission(baseInput({ enabled: false }));
  assert.equal(admission.effective, "off");
  assert.deepEqual(admission.reasons, [ADMISSION_REASON.disabled]);
  const workspace = resolveEffectiveMemoryAdmission(baseInput({ scopeKind: "workspace", enabled: false }));
  assert.equal(workspace.effective, "off");
  assert.deepEqual(workspace.reasons, [ADMISSION_REASON.disabled]);
});

test("developer shadow cannot bypass the disabled switch", () => {
  const admission = resolveEffectiveMemoryAdmission(
    baseInput({ rollout: "shadow", enabled: false }),
  );
  assert.equal(admission.effective, "off");
  assert.ok(admission.reasons.includes(ADMISSION_REASON.disabled));
});

test("lifecycle fence is collected alongside other denials and forces off", () => {
  const admission = resolveEffectiveMemoryAdmission(baseInput({ fenced: true, rollout: "off" }));
  assert.equal(admission.effective, "off");
  assert.deepEqual(admission.reasons, [
    ADMISSION_REASON.generationFence,
    ADMISSION_REASON.rolloutOff,
  ]);
  assert.equal(admission.generation, 1);
});

test("rollout off forces automatic memory off", () => {
  assert.equal(resolveEffectiveMemoryAdmission(baseInput({ rollout: "off" })).effective, "off");
});
