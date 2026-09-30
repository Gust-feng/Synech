import assert from "node:assert/strict";
import test from "node:test";

import { MemorySessionRepo } from "@earendil-works/pi-agent-core";
import { TODO_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { value } from "@earendil-works/pi-agent-core/harness/session";

import {
  SessionGenerationError,
  SessionWriteFence,
  appendMainMessage,
  getMainLeafId,
} from "../dist/adapters/intelligence/session-write-fence.js";

function userMessage(text) {
  return { role: "user", content: text, timestamp: Date.now() };
}

async function createSessionWithLeaves(id, count) {
  const repo = new MemorySessionRepo();
  const session = await repo.create({ id }, TODO_CONTEXT);
  await session.createBranch("main", null, TODO_CONTEXT);
  const leaves = [];
  for (let index = 1; index <= count; index += 1) {
    await appendMainMessage(session, userMessage(`${id}:${index}`));
    leaves.push(await getMainLeafId(session));
  }
  return { repo, session, leaves };
}

async function reopen(repo, session) {
  return repo.open(session.metadata, TODO_CONTEXT);
}

async function acquire(session) {
  const fence = new SessionWriteFence();
  const lease = await fence.acquire(async () => session);
  return { fence, lease };
}

function sessionWithHooks(session, hooks) {
  return new Proxy(session, {
    get(target, property, receiver) {
      if (property === "close" && hooks.close !== undefined) return hooks.close;
      if (property === "mutate" && hooks.mutate !== undefined) return hooks.mutate;
      if (property === "branch" && hooks.branch !== undefined) return hooks.branch;
      return Reflect.get(target, property, receiver);
    },
  });
}

test("Session fence rejects a second writer without opening another session", async () => {
  const { session } = await createSessionWithLeaves("fence-single", 1);
  let opens = 0;
  const fence = new SessionWriteFence();
  const lease = await fence.acquire(async () => {
    opens += 1;
    return session;
  });

  await assert.rejects(
    () => fence.acquire(async () => {
      opens += 1;
      return session;
    }),
    (error) => error instanceof SessionGenerationError && error.code === "generation_active",
  );

  assert.equal(opens, 1, "a rejected acquire must not open a second session");
  await lease.release();
});

test("Session fence refuses runWhenIdle while a writer generation is active", async () => {
  const { session } = await createSessionWithLeaves("fence-idle", 1);
  const fence = new SessionWriteFence();
  const lease = await fence.acquire(async () => session);

  await assert.rejects(
    () => fence.runWhenIdle(async () => "should not run"),
    (error) => error instanceof SessionGenerationError && error.code === "generation_active",
  );

  const ran = await fence.runWhenIdle(async () => "ran").catch(() => "did not run");
  assert.equal(ran, "did not run", "the run is still gated while the writer stays active");
  await lease.release();

  assert.equal(
    await fence.runWhenIdle(async () => "ran now"),
    "ran now",
    "after release the fence must admit idle work again",
  );
});

test("Session fence revokes a generation back to its durable recovery leaf", async () => {
  const { session, leaves } = await createSessionWithLeaves("fence-revoke", 3);
  const { lease } = await acquire(session);

  await lease.revokeTo(leaves[1]);

  assert.equal(
    await getMainLeafId(session),
    leaves[1],
    "revocation must restore the durable main branch tip",
  );
  await lease.release();
});

test("Session fence rejects writes from a revoked generation", async () => {
  const { session, leaves } = await createSessionWithLeaves("fence-revoked-write", 3);
  const { lease } = await acquire(session);
  await lease.revokeTo(leaves[1]);

  await assert.rejects(
    () => lease.session.setValue(value("fence.probe", "key"), 1, TODO_CONTEXT),
    (error) => error instanceof SessionGenerationError && error.code === "generation_revoked",
    "a revoked generation must not be able to write",
  );
  // Reads are gated as well: a revoked generation must not even resolve the
  // branch it would need in order to write.
  await assert.rejects(
    async () => lease.session.branch("main", TODO_CONTEXT),
    (error) => error instanceof SessionGenerationError && error.code === "generation_revoked",
    "a revoked generation must not be able to reach the transcript branch",
  );
});

test("Session fence requires exactly one recovery leaf target per generation", async () => {
  const { session, leaves } = await createSessionWithLeaves("fence-target", 3);
  const { lease } = await acquire(session);

  await lease.revokeTo(leaves[1]);
  await lease.revokeTo(leaves[1]);
  await assert.rejects(
    () => lease.revokeTo(leaves[2]),
    (error) => error instanceof SessionGenerationError && error.code === "generation_revoked",
    "a generation must not be able to move to a second recovery leaf",
  );
});

test("Session fence rejects writes from a released generation", async () => {
  const { session } = await createSessionWithLeaves("fence-released", 2);
  const { lease } = await acquire(session);
  await lease.release();

  await assert.rejects(
    () => lease.session.setValue(value("fence.probe", "key"), 1, TODO_CONTEXT),
    (error) => error instanceof SessionGenerationError && error.code === "generation_revoked",
    "a released generation must not be able to write",
  );
});

test("Session fence refuses to revoke a released generation", async () => {
  const { session, leaves } = await createSessionWithLeaves("fence-released-revoke", 3);
  const { lease } = await acquire(session);
  await lease.release();

  await assert.rejects(
    () => lease.revokeTo(leaves[1]),
    (error) => error instanceof SessionGenerationError && error.code === "generation_revoked",
    "a released generation must not be able to restore a durable leaf",
  );
});

test("Session fence lets a revoked generation be released and then reopened", async () => {
  const { repo, session, leaves } = await createSessionWithLeaves("fence-reopen", 3);
  const { fence, lease } = await acquire(session);
  await lease.revokeTo(leaves[1]);
  await lease.release();

  // release() closes the writer's session handle, so the next generation opens a
  // fresh one exactly the way FileSystemAgentSessionRepository does.
  const reopened = await fence.acquire(() => reopen(repo, session));
  assert.equal(
    await getMainLeafId(reopened.session),
    leaves[1],
    "the revoke requested in the same turn must own the durable leaf restore",
  );
  await reopened.release();
});

test("Session fence orders a same-turn release before revoke without deadlocking", async () => {
  const { repo, session, leaves } = await createSessionWithLeaves("fence-release-first", 3);
  const fence = new SessionWriteFence();
  const lease = await fence.acquire(async () => session);

  const releasing = lease.release();
  const revoking = lease.revokeTo(leaves[1]);
  await Promise.race([
    Promise.all([releasing, revoking]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("release/revoke deadlocked")), 1000)),
  ]);

  const reopened = await fence.acquire(() => reopen(repo, session));
  assert.equal(await getMainLeafId(reopened.session), leaves[1]);
  await reopened.release();
});

test("Session fence resolves and stores null revoke targets before comparing them", async () => {
  const { session, leaves } = await createSessionWithLeaves("fence-null-target", 2);
  const { lease } = await acquire(session);

  const first = lease.revokeTo(null);
  const second = lease.revokeTo(leaves[1]);
  await Promise.all([first, second]);
  await lease.revokeTo(null);
  await lease.release();
});

test("Session fence closes a failed revoke but keeps the failed generation blocking", async () => {
  const { session, leaves } = await createSessionWithLeaves("fence-revoke-failed-release", 2);
  let closeCalls = 0;
  const failingSession = sessionWithHooks(session, {
    mutate: async () => {
      throw new Error("revoke mutation failed");
    },
    close: async () => {
      closeCalls += 1;
    },
  });
  const fence = new SessionWriteFence();
  const lease = await fence.acquire(async () => failingSession);

  await assert.rejects(
    () => lease.revokeTo(leaves[0]),
    (error) => error instanceof SessionGenerationError && error.code === "generation_revoke_failed",
  );
  await lease.release();
  assert.equal(closeCalls, 1, "release must close the handle after revoke failure");

  await assert.rejects(
    () => fence.acquire(async () => session),
    (error) => error instanceof SessionGenerationError && error.code === "generation_revoke_failed",
    "a failed recovery must continue blocking the next generation after close",
  );
});

test("Session fence does not admit a successor after close fails", async () => {
  const { session } = await createSessionWithLeaves("fence-close-failed", 1);
  let closeCalls = 0;
  const closeError = new Error("close failed");
  const failingSession = sessionWithHooks(session, {
    close: async () => {
      closeCalls += 1;
      throw closeError;
    },
  });
  const fence = new SessionWriteFence();
  const lease = await fence.acquire(async () => failingSession);

  await assert.rejects(() => lease.release(), closeError);
  assert.equal(closeCalls, 1);
  await assert.rejects(
    () => fence.acquire(async () => session),
    (error) => error instanceof SessionGenerationError && error.code === "generation_active",
    "a still-open handle must not be hidden by a failed release",
  );
});

test("Session fence closes an opened handle when its main leaf cannot be read", async () => {
  const { session } = await createSessionWithLeaves("fence-open-leaf-failed", 1);
  let closeCalls = 0;
  const readError = new Error("main leaf read failed");
  const brokenSession = sessionWithHooks(session, {
    branch: async () => {
      throw readError;
    },
    close: async () => {
      closeCalls += 1;
    },
  });
  const fence = new SessionWriteFence();

  await assert.rejects(() => fence.acquire(async () => brokenSession), readError);
  assert.equal(closeCalls, 1, "an opened handle must be closed when validation fails");
});

test("Session fence detects a reopened session whose leaf was not restored", async () => {
  const first = await createSessionWithLeaves("fence-mismatch-a", 2);
  const second = await createSessionWithLeaves("fence-mismatch-b", 2);
  const fence = new SessionWriteFence();

  const lease = await fence.acquire(async () => first.session);
  await lease.revokeTo(first.leaves[0]);

  await assert.rejects(
    () => fence.acquire(async () => second.session),
    (error) => error instanceof SessionGenerationError && error.code === "generation_revoke_failed",
    "an unverified recovery leaf must fail explicitly instead of silently continuing",
  );
});

test("Session fence admits a new writer once the restored leaf is proven", async () => {
  const { session, leaves } = await createSessionWithLeaves("fence-proven", 3);
  const fence = new SessionWriteFence();

  const lease = await fence.acquire(async () => session);
  await lease.revokeTo(leaves[1]);

  const reopened = await fence.acquire(async () => session);
  assert.equal(await getMainLeafId(session), leaves[1]);
  await reopened.release();
});
