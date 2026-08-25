import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";

import {
  createOrdinaryTurnApplication,
  OrdinaryTurnApplicationError,
} from "../dist/app/application/ordinary-turn-application.js";
import { ordinaryTurnApplicationHttpError } from "../dist/app/panel-server/request-handler.js";

test("ordinary route delegates turn orchestration to one application command", async () => {
  const source = await fs.readFile("src/app/panel-server/ordinary/ordinary-routes.ts", "utf8");
  assert.match(source, /ordinaryTurnApplication\.submit/u);
  assert.doesNotMatch(source, /workbenchCoordination\.commands\.submitOrdinaryTurn/u);
  assert.doesNotMatch(source, /resolveConversationSpaceAccess|prepareOrdinaryRunBirth/u);
});

test("existing conversation uses canonical Space owner and deletion admission", async () => {
  const fixture = createFixture({
    conversationId: "conversation-1",
    owner: { kind: "space", id: "space-1" },
    spaceTree: { entries: [] },
  });

  const result = await fixture.application.submit({
    conversationId: "conversation-1",
    runInput: { goal: "continue" },
  });

  assert.deepEqual(result.owner, { kind: "space", id: "space-1" });
  assert.equal(result.spaceId, "space-1");
  assert.deepEqual(fixture.events, [
    "conversation-available:conversation-1",
    "space-available:space-1",
    "space-available:space-1",
    "birth:conversation-1",
    "space-admit:space-1",
    "submit:conversation-1",
  ]);
});

test("new Workspace conversation is submitted through lifecycle with generated submission id", async () => {
  const fixture = createFixture({});

  const result = await fixture.application.submit({
    runInput: { goal: "start", owner: { kind: "workspace", id: "workspace-1" } },
  });

  assert.equal(result.owner.kind, "workspace");
  assert.equal(fixture.lifecycleSubmission?.submissionId.length > 10, true);
  assert.deepEqual(fixture.events, [
    "workspace-available:workspace-1",
    "birth:undefined",
    "lifecycle-submit",
  ]);
});

test("owner conflict is rejected before run birth", async () => {
  const fixture = createFixture({
    conversationId: "conversation-1",
    owner: { kind: "space", id: "space-1" },
    spaceTree: { entries: [] },
  });

  await assert.rejects(
    fixture.application.submit({
      conversationId: "conversation-1",
      runInput: { goal: "wrong scope", owner: { kind: "workspace", id: "workspace-1" } },
    }),
    (error) => error instanceof OrdinaryTurnApplicationError && error.code === "conversation_owner_conflict",
  );
  const mapped = ordinaryTurnApplicationHttpError(new OrdinaryTurnApplicationError(
    "conversation_owner_conflict",
    "owner conflict",
  ));
  assert.equal(mapped.statusCode, 409);
  assert.equal(mapped.code, "conversation_owner_conflict");
  assert.equal(fixture.events.includes("birth:conversation-1"), false);
});

test("new conversation requires an explicit owner", async () => {
  const fixture = createFixture({});

  await assert.rejects(
    fixture.application.submit({ runInput: { goal: "missing owner" } }),
    (error) => error instanceof OrdinaryTurnApplicationError && error.code === "new_conversation_owner_required",
  );
  const mapped = ordinaryTurnApplicationHttpError(new OrdinaryTurnApplicationError(
    "new_conversation_owner_required",
    "owner required",
  ));
  assert.equal(mapped.statusCode, 400);
  assert.equal(mapped.code, "conversation_owner_required");
  assert.deepEqual(fixture.events, []);
});

function createFixture({ conversationId, owner, spaceTree }) {
  const events = [];
  let lifecycleSubmission;
  const result = {
    conversation: { conversationId: conversationId ?? "conversation-new" },
    run: { runId: "run-1" },
  };
  const application = createOrdinaryTurnApplication({
    ordinaryAgentFeature: {
      commands: {
        async submitTurn(input) {
          events.push(`submit:${input.conversationId}`);
          return result;
        },
      },
      queries: {
        async getConversationOwner(id) {
          return id === conversationId ? owner : undefined;
        },
      },
    },
    spaceFeature: { queries: { async getTree() { return spaceTree; } } },
    workspaceFeature: {
      commands: { async invalidateMount() {} },
      queries: { async get() { return undefined; } },
    },
    conversationLifecycle: {
      assertConversationAvailable(id) { events.push(`conversation-available:${id}`); },
      async submit(input) {
        lifecycleSubmission = input;
        events.push("lifecycle-submit");
        return result;
      },
    },
    spaceConversationDeletion: {
      assertAvailable(id) { events.push(`space-available:${id}`); },
      async admit(id, operation) {
        events.push(`space-admit:${id}`);
        return operation();
      },
    },
    workspaceDeletion: {
      assertAvailable(id) { events.push(`workspace-available:${id}`); },
      async admit(id, operation) {
        events.push(`workspace-admit:${id}`);
        return operation();
      },
    },
    async resolveSpaceAccess({ contextInput, requestedSpaceId }) {
      return requestedSpaceId === undefined
        ? { contextInput }
        : { spaceId: requestedSpaceId, contextInput };
    },
    async prepareOrdinaryRunBirth(_input, id) { events.push(`birth:${id}`); return {}; },
  });
  return { application, events, get lifecycleSubmission() { return lifecycleSubmission; } };
}
