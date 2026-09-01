import assert from "node:assert/strict";
import test from "node:test";

import { createOrdinaryEvidenceReader } from "../dist/app/panel-server/ordinary/ordinary-evidence-reader.js";

function run(ordinal, overrides = {}) {
  return {
    runId: `r${ordinal}`,
    ordinal,
    userTurnId: `u${ordinal}`,
    assistantTurnId: `a${ordinal}`,
    userMessage: `question ${ordinal}`,
    assistantText: `answer ${ordinal}`,
    sourceRevision: ordinal + 10,
    occurredAt: `2026-09-02T0${ordinal}:00:00.000Z`,
    ...overrides,
  };
}

// Fake queries：记录调用范围并返回给定 run（模拟已按 ordinal 升序）。
function fakeQueries(runs, received = []) {
  return {
    async listStableEvidenceRuns(conversationId, range) {
      received.push({ conversationId, ...range });
      return runs.filter(
        (item) => item.ordinal >= range.fromOrdinal && item.ordinal <= range.throughOrdinal,
      );
    },
  };
}

const windowOf = (reader, fromOrdinal, throughOrdinal) =>
  reader.readTurnWindow({
    conversationId: "c1",
    fromOrdinal,
    through: { turnId: `u${throughOrdinal}`, ordinal: throughOrdinal, sourceRevision: throughOrdinal + 10 },
  });

test("continuous runs expand to user then assistant turns and cursor covers the last ordinal", async () => {
  const reader = createOrdinaryEvidenceReader(fakeQueries([run(1), run(2), run(3)]));
  const window = await windowOf(reader, 1, 3);
  assert.equal(window.turns.length, 6);
  assert.deepEqual(
    window.turns.map((turn) => `${turn.ordinal}:${turn.role}`),
    ["1:user", "1:assistant", "2:user", "2:assistant", "3:user", "3:assistant"],
  );
  assert.deepEqual(window.nextCursor, {
    conversationId: "c1",
    coveredThroughOrdinal: 3,
    sourceFingerprint: "rev:13",
  });
});

test("a gap (missing ordinal 2) stops at the continuous block; cursor never jumps over the hole", async () => {
  const reader = createOrdinaryEvidenceReader(fakeQueries([run(1), run(3)]));
  const window = await windowOf(reader, 1, 3);
  assert.equal(window.turns.length, 2);
  assert.equal(window.turns[0].ordinal, 1);
  assert.deepEqual(window.nextCursor?.coveredThroughOrdinal, 1);
});

test("reading starts exactly at the cursor's next ordinal", async () => {
  const reader = createOrdinaryEvidenceReader(fakeQueries([run(2), run(3)]));
  const window = await windowOf(reader, 2, 3);
  assert.equal(window.turns.length, 4);
  assert.equal(window.turns[0].ordinal, 2);
  assert.deepEqual(window.nextCursor?.coveredThroughOrdinal, 3);
});

test("no stable run in range yields no turns and no cursor (must not advance)", async () => {
  const reader = createOrdinaryEvidenceReader(fakeQueries([]));
  const window = await windowOf(reader, 1, 2);
  assert.deepEqual(window.turns, []);
  assert.equal(window.nextCursor, undefined);
});

test("a run with empty assistant text contributes only the user turn", async () => {
  const reader = createOrdinaryEvidenceReader(fakeQueries([run(1, { assistantText: "" })]));
  const window = await windowOf(reader, 1, 1);
  assert.equal(window.turns.length, 1);
  assert.equal(window.turns[0].role, "user");
  assert.deepEqual(window.nextCursor?.coveredThroughOrdinal, 1);
});
