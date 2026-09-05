import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMISSION_REASON,
  resolveEffectiveMemoryAdmission,
} from "../dist/app/memory/index.js";

function baseInput(overrides = {}) {
  return {
    scopeKind: "space",
    globalConsent: true,
    spaceParticipation: true,
    rollout: "active",
    fenced: false,
    generation: 1,
    policyRevision: "p1",
    rolloutRevision: "r1",
    ...overrides,
  };
}

test("all gates open: active/shadow pass through rollout", () => {
  assert.equal(resolveEffectiveMemoryAdmission(baseInput()).effective, "active");
  assert.equal(
    resolveEffectiveMemoryAdmission(baseInput({ rollout: "shadow" })).effective,
    "shadow",
  );
});

test("Space participation is the smallest automatic-memory scope", () => {
  const admission = resolveEffectiveMemoryAdmission(baseInput({ spaceParticipation: false }));
  assert.equal(admission.effective, "off");
  assert.deepEqual(admission.reasons, [ADMISSION_REASON.spaceParticipation]);
});

test("developer shadow cannot bypass missing global consent", () => {
  const admission = resolveEffectiveMemoryAdmission(
    baseInput({ rollout: "shadow", globalConsent: false }),
  );
  assert.equal(admission.effective, "off");
  assert.ok(admission.reasons.includes(ADMISSION_REASON.globalConsent));
});

test("global view ignores participation and Workspace can never enter automatic memory", () => {
  const globalIgnored = resolveEffectiveMemoryAdmission(
    baseInput({ scopeKind: "global", spaceParticipation: false }),
  );
  assert.equal(globalIgnored.effective, "active");
  const workspace = resolveEffectiveMemoryAdmission(
    baseInput({ scopeKind: "workspace", spaceParticipation: true }),
  );
  assert.equal(workspace.effective, "off");
  assert.deepEqual(workspace.reasons, [ADMISSION_REASON.spaceParticipation]);
});

test("lifecycle fence is collected alongside other denials and forces off", () => {
  const admission = resolveEffectiveMemoryAdmission(
    baseInput({ fenced: true, rollout: "off" }),
  );
  assert.equal(admission.effective, "off");
  assert.deepEqual(admission.reasons, [
    ADMISSION_REASON.generationFence,
    ADMISSION_REASON.rolloutOff,
  ]);
  assert.equal(admission.generation, 1);
});

test("rollout off forces automatic memory off", () => {
  assert.equal(
    resolveEffectiveMemoryAdmission(baseInput({ rollout: "off" })).effective,
    "off",
  );
});
