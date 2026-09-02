import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase } from "../dist/adapters/runtime-storage/index.js";
import { createMemoryCaptureApplication } from "../dist/app/application/memory-capture-application.js";
import {
  createMemoryRuntime,
  createSqliteMemoryContentRepository,
  createSqliteMemoryControlRepository,
} from "../dist/app/memory/index.js";
import { createMemoryCaptureScheduler } from "../dist/app/panel-server/memory/capture-scheduler.js";
import { POLICY_KEY, participationKey } from "../dist/app/memory/policy/policy-snapshot.js";

test("memory end-to-end: stable conversation capture, consolidation, recall, and contribution", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "synech-memory-e2e-"));
  const database = new SqliteRuntimeDatabase(path.join(dir, "synech.sqlite3"));
  const owner = { kind: "space", id: "space-e2e" };
  const conversation = {
    conversationId: "conversation-e2e",
    owner,
    turns: [
      { ordinal: 1, user: "我们决定把项目数据放在 SQLite 中。", assistant: "已确认使用 SQLite。" },
      { ordinal: 2, user: "这个决定适用于本项目的本地持久化。", assistant: "后续本地存储沿用 SQLite。" },
      { ordinal: 3, user: "请把这个持久化决定保留给后续协作。", assistant: "我会把它作为长期协作背景。" },
    ],
  };
  const control = createSqliteMemoryControlRepository(database);
  const content = createSqliteMemoryContentRepository(database);
  const evidenceReader = {
    async readTurnWindow({ conversationId, fromOrdinal, through }) {
      const turns = conversation.turns
        .filter((turn) => turn.ordinal >= fromOrdinal && turn.ordinal <= through.ordinal)
        .flatMap((turn) => [
          {
            conversationId,
            runId: "run-" + turn.ordinal,
            turnId: "user-" + turn.ordinal,
            ordinal: turn.ordinal,
            role: "user",
            text: turn.user,
            occurredAt: "2026-09-02T00:00:00.000Z",
            sourceRevision: turn.ordinal,
          },
          {
            conversationId,
            runId: "run-" + turn.ordinal,
            turnId: "assistant-" + turn.ordinal,
            ordinal: turn.ordinal,
            role: "assistant",
            text: turn.assistant,
            occurredAt: "2026-09-02T00:00:00.000Z",
            sourceRevision: turn.ordinal,
          },
        ]);
      const last = turns.at(-1);
      return {
        turns,
        nextCursor: last === undefined
          ? undefined
          : {
              conversationId,
              coveredThroughOrdinal: last.ordinal,
              sourceFingerprint: "rev:" + last.sourceRevision,
            },
      };
    },
  };
  const model = {
    async extract() {
      return {
        status: "completed",
        text: JSON.stringify({
          operations: [{
            op: "create",
            kind: "decision",
            text: "本项目本地持久化采用 SQLite。",
            evidenceClass: "quoted_user_evidence",
            evidence: [{ fromOrdinal: 1, toOrdinal: 3 }],
          }],
        }),
      };
    },
  };
  const runtime = createMemoryRuntime({
    controlRepository: control,
    contentRepository: content,
    evidenceReader,
  });
  const scheduler = createMemoryCaptureScheduler({
    controlRepository: control,
    contentRepository: content,
    evidenceReader,
    model,
  });

  try {
    await control.setPolicy({
      key: POLICY_KEY.consent,
      kind: "global_consent",
      scopeOwnerKey: null,
      enabled: true,
    });
    await control.setPolicy({
      key: POLICY_KEY.rollout,
      kind: "rollout",
      scopeOwnerKey: "active",
      enabled: true,
    });
    await control.setPolicy({
      key: participationKey("space:space-e2e"),
      kind: "scope_participation",
      scopeOwnerKey: "space:space-e2e",
      enabled: true,
    });

    const captureApplication = createMemoryCaptureApplication({
      ordinary: {
        queries: {
          async getStableTerminalRunFacts() {
            return {
              runId: "run-3",
              sourceRevision: 3,
              turn: {
                conversationId: conversation.conversationId,
                ordinal: 3,
                userTurnId: "user-3",
                assistantTurnId: "assistant-3",
              },
              turnMemoryOverrideOff: false,
            };
          },
          async getConversationOwner() {
            return owner;
          },
        },
      },
      captureRuntime: runtime.captureRuntime,
      onActivity: (conversationId) => {
        assert.equal(conversationId, conversation.conversationId);
      },
    });
    const acceptance = await captureApplication.acceptStableRun("run-3");
    assert.equal(acceptance.status, "accepted");

    await scheduler.recoverQueuedJobs();

    const records = await content.listActiveByOwner("space:space-e2e");
    assert.equal(records.length, 1);
    assert.equal((await content.getCursor(conversation.conversationId))?.coveredThroughOrdinal, 3);

    const contribution = await runtime.contextProvider.contribute({
      owner,
      conversationId: conversation.conversationId,
      currentUserText: "本项目的 SQLite 持久化决定是什么？",
      deadlineAt: Date.now() + 1_000,
    });
    assert.equal(contribution.entries.length, 1);
    assert.equal(contribution.entries[0].modelText, "本项目本地持久化采用 SQLite。");
  } finally {
    await scheduler.release();
    database.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
