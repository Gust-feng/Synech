import assert from "node:assert/strict";
import test from "node:test";

import { withOrderedSpaceAdmissions } from "../dist/app/ownership/admission.js";
import { sameResolvedSource } from "../dist/app/local-filesystem/resolved-source.js";

test("ordered admissions serialize multiple Spaces deterministically", async () => {
  const events = [];
  const admission = {
    async admit(spaceId, operation) {
      events.push(["enter", spaceId]);
      const result = await operation();
      events.push(["exit", spaceId]);
      return result;
    },
  };
  await withOrderedSpaceAdmissions(admission, ["space-b", "space-a", "space-b"], async () => {
    events.push(["operation"]);
  });
  assert.deepEqual(events, [
    ["enter", "space-a"],
    ["enter", "space-b"],
    ["operation"],
    ["exit", "space-b"],
    ["exit", "space-a"],
  ]);
});

test("resolved source comparison requires path, kind, identity, and mount version", () => {
  const base = { path: "C:/project", sourceKind: "workspace", sourceIdentity: "source-1", mountVersion: "mount-1" };
  assert.equal(sameResolvedSource(base, { ...base }), true);
  assert.equal(sameResolvedSource(base, { ...base, sourceIdentity: "source-2" }), false);
  assert.equal(sameResolvedSource(base, { ...base, mountVersion: "mount-2" }), false);
  assert.equal(sameResolvedSource(base, { ...base, sourceKind: "managed_folder" }), false);
  assert.equal(sameResolvedSource(base, { ...base, path: "C:/other" }), false);
});
