import assert from "node:assert/strict";
import test from "node:test";

import { createOrdinaryAgentFeature } from "../dist/app/ordinary-agent/ordinary-agent-feature.js";

const NOW = "2026-01-01T00:00:00.000Z";

function runSummary(runId, conversationId) {
  return {
    runId, conversationId, userTurnId: "user-1", assistantTurnId: "assistant-1",
    status: "completed", createdAt: NOW, updatedAt: NOW,
  };
}

function createFixture({ conversationList }) {
  const diagnostics = [];
  const summaries = [runSummary("run-1", "conversation-1")];
  const feature = createOrdinaryAgentFeature({
    repository: {
      save: async () => { throw new Error("unexpected save"); },
      get: async () => undefined,
      list: async () => summaries,
      inspectRecoveryInventory: async () => ({ summaries, issues: [] }),
      delete: async () => { throw new Error("unexpected delete"); },
    },
    conversationRepository: {
      save: async () => { throw new Error("unexpected save"); },
      delete: async () => { throw new Error("unexpected delete"); },
      get: async () => undefined,
      list: conversationList,
    },
    execution: {
      start: async () => { throw new Error("unexpected start"); },
      cancel: async () => { throw new Error("unexpected cancel"); },
    },
    sessionRepository: {},
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { feature, diagnostics };
}

test("conversation enumeration failure no longer isolates every recovered run", async () => {
  const fixture = createFixture({
    conversationList: async () => { throw new Error("transient IO failure"); },
  });

  const visible = await fixture.feature.queries.listRuns();
  assert.deepEqual(visible.map((summary) => summary.runId), ["run-1"]);
  assert.equal(
    fixture.diagnostics.some((diagnostic) =>
      diagnostic.kind === "startup_recovery_failed" && diagnostic.source === "conversation_repository"),
    true,
  );
  assert.equal(
    fixture.diagnostics.some((diagnostic) =>
      diagnostic.kind === "conversation_unavailable" && diagnostic.conversationId === "conversation-1"),
    false,
  );
});

test("a genuinely missing control document still isolates its run", async () => {
  const fixture = createFixture({ conversationList: async () => [] });

  const visible = await fixture.feature.queries.listRuns();
  assert.deepEqual(visible, []);
  assert.equal(
    fixture.diagnostics.some((diagnostic) =>
      diagnostic.kind === "conversation_unavailable" && diagnostic.conversationId === "conversation-1"),
    true,
  );
});
