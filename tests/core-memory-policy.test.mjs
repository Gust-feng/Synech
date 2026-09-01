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
    scopeParticipation: true,
    conversationExcluded: false,
    turnOverrideOff: false,
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

test("conversation exclusion wins even when consent and rollout are active", () => {
  const admission = resolveEffectiveMemoryAdmission(
    baseInput({ conversationExcluded: true }),
  );
  assert.equal(admission.effective, "off");
  assert.deepEqual(admission.reasons, [ADMISSION_REASON.conversationExclusion]);
});

test("developer shadow cannot bypass missing global consent", () => {
  const admission = resolveEffectiveMemoryAdmission(
    baseInput({ rollout: "shadow", globalConsent: false }),
  );
  assert.equal(admission.effective, "off");
  assert.ok(admission.reasons.includes(ADMISSION_REASON.globalConsent));
});

test("space participation gates non-global scope but is ignored for global scope", () => {
  const scopedOff = resolveEffectiveMemoryAdmission(
    baseInput({ scopeParticipation: false }),
  );
  assert.equal(scopedOff.effective, "off");
  assert.ok(scopedOff.reasons.includes(ADMISSION_REASON.scopeParticipation));
  const globalIgnored = resolveEffectiveMemoryAdmission(
    baseInput({ scopeKind: "global", scopeParticipation: false }),
  );
  assert.equal(globalIgnored.effective, "active");
});

test("lifecycle fence is collected alongside other denials and forces off", () => {
  const admission = resolveEffectiveMemoryAdmission(
    baseInput({ fenced: true, conversationExcluded: true, rollout: "off" }),
  );
  assert.equal(admission.effective, "off");
  assert.deepEqual(admission.reasons, [
    ADMISSION_REASON.generationFence,
    ADMISSION_REASON.conversationExclusion,
    ADMISSION_REASON.rolloutOff,
  ]);
  assert.equal(admission.generation, 1);
});

test("turn override forces off and rollout off forces off", () => {
  assert.equal(
    resolveEffectiveMemoryAdmission(baseInput({ turnOverrideOff: true })).effective,
    "off",
  );
  assert.equal(
    resolveEffectiveMemoryAdmission(baseInput({ rollout: "off" })).effective,
    "off",
  );
});
