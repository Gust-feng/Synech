import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqliteRuntimeDatabase, SqliteMigrationIntegrityError } from "../dist/adapters/runtime-storage/index.js";
import { initializeProductStorage, resolveProductPaths } from "../dist/platform/storage/index.js";
import { createPanelHost } from "../dist/app/panel-server/panel-host.js";
import { closePanelServer, releasePanelHostResources } from "../dist/app/panel-server/request-handler.js";
import { POLICY_KEY, createMemoryCaptureRuntime, createSqliteMemoryControlRepository,
  createSqliteMemoryDocumentRepository } from "../dist/app/memory/composition.js";
import { createMemoryMaintenanceScheduler } from "../dist/app/panel-server/memory/capture-scheduler.js";

function gate() {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  return { promise, open };
}

const signal = (conversationId) => ({ owner: { kind: "space", id: "s1" }, conversationId,
  stableThrough: { turnId: "u1", ordinal: 1, sourceRevision: 1 } });

async function enable(control) {
  await control.setPolicy({ key: POLICY_KEY.consent, kind: "global_consent", scopeOwnerKey: null, enabled: true });
  await control.setPolicy({ key: POLICY_KEY.rollout, kind: "rollout", scopeOwnerKey: "active", enabled: true });
}

function containsError(error, expected) {
  return error === expected || (error instanceof AggregateError && error.errors.some(item => containsError(item, expected)));
}

// Actual Panel shutdown and actual SQLite publication: the delayed Ordinary
// evidence query must finish before Ordinary and its shared database disappear.
async function closeScenario(failClose) {
  const integrityError = new SqliteMigrationIntegrityError("shutdown close integrity fixture");
  const productHome = await mkdtemp(path.join(os.tmpdir(), "synech-memory-shutdown-"));
  const entered = gate(), resume = gate();
  let host, server, closing;
  try {
    const productPaths = resolveProductPaths({ productHome });
    await initializeProductStorage(productPaths);
    host = createPanelHost({ productPaths });
    await host.memoryReady;
    await host.ensureDefaultSpace();
    await host.conversationLifecycle.ready();
    await host.spaceConversationDeletion.ready();
    await host.workspaceDeletion.ready();
    const control = createSqliteMemoryControlRepository(host.database);
    const documents = createSqliteMemoryDocumentRepository(host.database);
    await enable(control);
    host.ordinaryAgentFeature.queries.listStableEvidenceRuns = async () => {
      entered.open();
      await resume.promise;
      return [{ runId: "r1", ordinal: 1, userTurnId: "u1", assistantTurnId: "a1",
        userMessage: "shutdown evidence", assistantText: "", sourceRevision: 1,
        occurredAt: "2026-10-03T00:00:00.000Z" }];
    };
    const acceptance = host.memoryRuntime.captureRuntime.acceptStableSignal(signal("c1"));
    await entered.promise;
    server = createServer();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    let closed = false;
    const closeDatabase = host.database.close.bind(host.database);
    host.database.close = () => {
      assert.equal(host.database.connection.prepare("SELECT COUNT(*) AS n FROM memory_transcript_fts").get().n, 1);
      closed = true;
      closeDatabase();
      if (failClose) throw integrityError;
    };
    closing = closePanelServer(server, host);
    const release = host.releaseMemoryRuntime();
    assert.equal(host.releaseMemoryRuntime(), release, "all callers share one shutdown barrier");
    assert.equal((await host.memoryRuntime.captureRuntime.acceptStableSignal(signal("late"))).status, "skipped");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, "SQLite stays open while admitted evidence is pending");
    assert.equal((await control.listJobsByStatus("queued")).length, 0);
    resume.open();
    assert.equal((await acceptance).status, "accepted");
    if (failClose) await assert.rejects(closing, error => containsError(error, integrityError));
    else await closing;
    assert.equal(closed, true);
  } finally {
    resume.open();
    if (closing !== undefined) await Promise.allSettled([closing]);
    else if (host !== undefined) await releasePanelHostResources(host);
    server?.closeAllConnections();
    await rm(productHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("Panel close drains Memory capture before SQLite closes and stops new admission", async () => {
  await closeScenario(false);
  await closeScenario(true);
});

// Recovery can be awaiting SQLite before a drain promise even exists. Shutdown
// must keep the connection alive through that recovery, without claiming work.
test("Memory release waits startup recovery and preserves SQLite integrity failures", async () => {
  for (const phase of ["recovery", "drain", "recovery_failure"]) {
    const failRecovery = phase === "recovery_failure";
    const root = await mkdtemp(path.join(os.tmpdir(), "synech-memory-recovery-shutdown-"));
    const database = new SqliteRuntimeDatabase(path.join(root, "synech.sqlite3"));
    const control = createSqliteMemoryControlRepository(database);
    const documents = createSqliteMemoryDocumentRepository(database);
    const entered = gate(), resume = gate();
    const integrityError = new SqliteMigrationIntegrityError("shutdown recovery integrity fixture");
    let scheduler, recovery, release;
    try {
      await enable(control);
      const capture = createMemoryCaptureRuntime({ controlRepository: control, documentRepository: documents,
        evidenceReader: { async readTurnWindow() { return { turns: [] }; } }, idleDelayMs: 0, now: () => 1 });
      await capture.acceptStableSignal(signal("c-recover"));
      await capture.release();
      const [queued] = await control.listJobsByStatus("queued");
      await control.claimJob({ jobId: queued.jobId, claimToken: "interrupted", now: 2 });
      const recover = control.recoverInterruptedJobs.bind(control);
      if (phase === "drain") {
        const listDue = control.listDueJobs.bind(control);
        control.listDueJobs = async input => {
          entered.open();
          await resume.promise;
          return await listDue(input);
        };
      } else {
        control.recoverInterruptedJobs = async () => {
          entered.open();
          await resume.promise;
          if (failRecovery) throw integrityError;
          return await recover();
        };
      }
      scheduler = createMemoryMaintenanceScheduler({ controlRepository: control, documentRepository: documents,
        evidenceReader: { async readTurnWindow() { throw new Error("released scheduler read evidence"); } },
        model: { async generate() { throw new Error("released scheduler called model"); } },
        onDiagnostic() {}, now: () => 3 });
      recovery = scheduler.recoverQueuedJobs();
      await entered.promise;
      release = scheduler.release();
      assert.equal(scheduler.release(), release);
      let settled = false;
      void release.then(() => { settled = true; }, () => { settled = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, "release must include startup recovery and its in-flight drain");
      assert.equal((await control.listJobsByStatus(phase === "drain" ? "queued" : "running")).length, 1);
      resume.open();
      await recovery;
      if (failRecovery) {
        await assert.rejects(release, error => containsError(error, integrityError));
      } else {
        await release;
        assert.equal((await control.listJobsByStatus("queued")).length, 1, "recovered work remains durable for restart");
        assert.equal((await control.listJobsByStatus("running")).length, 0);
      }
    } finally {
      resume.open();
      await Promise.allSettled([recovery, release ?? scheduler?.release()]);
      database.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});
