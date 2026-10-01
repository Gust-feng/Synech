import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";
import { createServer } from "vite";

let server;
let confirmations;
let controllers;
let observations;

before(async () => {
  server = await createServer({
    configFile: false,
    root: path.resolve(import.meta.dirname, ".."),
    cacheDir: ".tmp/conversation-observation-test-cache",
    resolve: { alias: { "@panel-api": path.resolve(import.meta.dirname, "../src/app/panel-api") } },
    server: { middlewareMode: true, hmr: false, watch: null },
    logLevel: "error",
  });
  const root = "/src/app/panel-ui/src/features/conversations/run";
  confirmations = await server.ssrLoadModule(`${root}/confirmation-decisions.ts`);
  controllers = await server.ssrLoadModule(`${root}/controller.ts`);
  observations = await server.ssrLoadModule(`${root}/live-run-updates.ts`);
});

after(async () => {
  await server?.close();
});

test("approval responses cannot replace another conversation, including failures and follow-up reads", async (t) => {
  for (const scenario of ["success", "failure", "stale_confirmation", "read_success", "read_failure", "same_run_new_epoch"]) {
    await t.test(scenario, async (t) => {
      const state = observationState("A", "approval_needed");
      const post = deferred();
      const read = deferred();
      const starts = [];
      let reads = 0;
      t.mock.method(globalThis, "fetch", async (url, init) => {
        if (init?.method === "POST") return post.promise;
        reads += 1;
        assert.equal(url, "/api/conversations/A");
        return read.promise;
      });
      const pending = confirmations.decideRunConfirmation({
        ...state.options,
        app: state.app,
        currentRunId: "A-run",
        decision: "approve_once",
        confirmationBusy: false,
        refreshConversations: async () => {},
        startLiveUpdates: (subscription) => starts.push(subscription),
      });
      if (scenario.startsWith("read_")) {
        post.resolve(Response.json({ run: run("A", "running") }));
        await flush();
        assert.equal(reads, 1);
      }
      if (scenario === "same_run_new_epoch") state.options.viewEpochRef.current += 1;
      else state.navigate("B");
      const expected = state.app;
      if (scenario === "failure") post.reject(new Error("old approval failed"));
      else if (scenario === "stale_confirmation") {
        post.resolve(Response.json({
          error: { code: "ordinary_confirmation_not_found", message: "already decided" },
        }, { status: 409 }));
      } else if (scenario === "read_failure") read.reject(new Error("old snapshot failed"));
      else if (scenario === "read_success") read.resolve(Response.json({ conversation: conversation("A", "running") }));
      else post.resolve(Response.json({ run: run("A", "running") }));
      await pending;
      assert.equal(state.app, expected);
      assert.deepEqual(starts, []);
      assert.equal(reads, scenario.startsWith("read_") ? 1 : 0);
    });
  }
});

test("cancel responses preserve the newer run's ref, stream and cancellation marker", async (t) => {
  for (const outcome of ["success", "failure"]) {
    await t.test(outcome, async (t) => {
      installBrowserPrimitives(t);
      const state = observationState("A");
      const post = deferred();
      const reads = [];
      t.mock.method(globalThis, "fetch", async (url, init) => {
        if (init?.method === "POST") return post.promise;
        reads.push(url);
        throw new Error("a retired cancellation must not read or resume");
      });
      const pending = controllers.createAppRunController(state.options).cancelRun();
      state.navigate("B");
      const newerStream = new FakeEventSource("B");
      state.options.streamRef.current = newerStream;
      state.options.setCancellingRunId("B-run");
      const expected = state.app;
      if (outcome === "success") post.resolve(Response.json({ run: run("A", "cancelled") }));
      else post.reject(new Error("old cancellation failed"));
      await pending;
      await flush();
      assert.equal(state.app, expected);
      assert.equal(state.options.activeRunIdRef.current, "B-run");
      assert.equal(state.options.streamRef.current, newerStream);
      assert.equal(newerStream.closed, false);
      assert.equal(state.cancellingRunId, "B-run");
      assert.deepEqual(reads, []);
    });
  }
});

test("retired SSE work cannot close the newer stream or clear its polling timer", async (t) => {
  for (const scenario of ["failure", "success", "same_run_restart"]) {
    await t.test(scenario, async (t) => {
      const timers = installBrowserPrimitives(t);
      const state = observationState("A");
      const requests = [];
      t.mock.method(globalThis, "fetch", async (url) => {
        const pending = deferred();
        requests.push({ url, pending });
        return pending.promise;
      });
      const updates = observations.createLiveRunUpdateController(state.options);
      updates.startLiveUpdates({ runId: "A-run", conversationId: "A", epoch: 1 });
      const oldStream = state.options.streamRef.current;
      oldStream.emit("run.stream.heartbeat");
      const oldTimerCallback = timers.callbacks.get(state.options.pollTimer.current);
      oldStream.emit("tool.completed", event("A", "tool.completed", 1), "old-cursor");
      await flush();
      assert.equal(requests.length, 2);

      const nextId = scenario === "same_run_restart" ? "A" : "B";
      if (nextId === "B") state.navigate(nextId);
      updates.startLiveUpdates({
        runId: `${nextId}-run`, conversationId: nextId, epoch: state.options.viewEpochRef.current,
      });
      const newStream = state.options.streamRef.current;
      const newTimer = state.options.pollTimer.current;
      const expected = state.app;
      if (scenario === "success") {
        requests[1].pending.resolve(Response.json({ view: view("A", "completed") }));
      } else {
        requests[1].pending.reject(new Error("retired stream snapshot failed"));
      }
      // Bootstrap failures and late stream callbacks share the same boundary.
      requests[0].pending.reject(new Error("retired bootstrap failed"));
      await flush();
      oldStream.emit("run.stream.heartbeat");
      oldStream.emit("run.stream.reset", { cursor: "retired-reset" }, "retired-reset");
      oldStream.onerror?.();
      oldTimerCallback();
      await flush();
      assert.equal(state.app, expected);
      assert.equal(state.options.activeRunIdRef.current, `${nextId}-run`);
      assert.equal(state.options.streamRef.current, newStream);
      assert.equal(newStream.closed, false);
      assert.equal(state.options.pollTimer.current, newTimer);
      assert.ok(timers.callbacks.has(newTimer));
      assert.equal(requests.length, 3);
      updates.startPolling({ runId: "A-run", conversationId: "A", epoch: 0 });
      assert.equal(state.options.streamRef.current, newStream);
      state.options.mountedRef.current = false;
      requests[2].pending.resolve(Response.json({ view: view(nextId) }));
      await flush();
    });
  }
});

test("a retired polling settlement cannot overwrite approval recovery or restart after same-run SSE", async (t) => {
  const timers = installBrowserPrimitives(t);
  const state = observationState("A", "approval_needed");
  const subscription = { runId: "A-run", conversationId: "A", epoch: 1 };
  const settlementView = deferred();
  const settlementConversation = deferred();
  const requests = [];
  let runReads = 0;
  let conversationReads = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push([init?.method ?? "GET", url]);
    if (init?.method === "POST") return Response.json({ run: run("A", "running") });
    if (url === "/api/conversations/A") {
      conversationReads += 1;
      return conversationReads === 1
        ? settlementConversation.promise
        : Response.json({ conversation: conversation("A", "running") });
    }
    assert.ok(url.startsWith("/api/ordinary/runs/A-run/view"));
    runReads += 1;
    if (runReads === 1) return Response.json({ view: view("A", "approval_needed") });
    if (runReads === 2) return settlementView.promise;
    return Response.json({ view: view("A", "running") });
  });
  observations.createLiveRunUpdateController(state.options).startPolling(subscription);
  const oldTimerCallback = timers.callbacks.get(state.options.pollTimer.current);
  await flush();
  assert.equal(runReads, 2);
  assert.equal(conversationReads, 1);
  const oldRequest = state.options.fallbackPollRef.current;

  // Approval resumes the same run and epoch using a newly rendered controller.
  const resumed = observations.createLiveRunUpdateController(state.options);
  await confirmations.decideRunConfirmation({
    ...state.options,
    app: state.app,
    currentRunId: "A-run",
    decision: "approve_once",
    confirmationBusy: false,
    startLiveUpdates: resumed.startLiveUpdates,
  });
  await flush();
  assert.equal(oldRequest.signal.aborted, true);
  const newStream = state.options.streamRef.current;
  const newTimer = state.options.pollTimer.current;
  const expected = state.app;
  const requestCount = requests.length;
  assert.equal(expected.run.status, "running");

  settlementView.resolve(Response.json({ view: view("A", "approval_needed") }));
  settlementConversation.resolve(Response.json({ conversation: conversation("A", "approval_needed") }));
  await flush();
  assert.equal(state.app, expected);
  assert.equal(state.app.run.status, "running");
  assert.equal(state.app.detail.status, "running");
  assert.equal(state.options.streamRef.current, newStream);
  assert.equal(newStream.closed, false);
  assert.equal(state.options.pollTimer.current, newTimer);
  assert.ok(timers.callbacks.has(newTimer));
  assert.equal(state.options.fallbackPollRef.current, undefined);
  assert.equal(requests.length, requestCount);
  oldTimerCallback();
  await flush();
  assert.equal(state.app, expected);
  assert.equal(state.options.streamRef.current, newStream);
  assert.equal(state.options.pollTimer.current, newTimer);
  assert.ok(timers.callbacks.has(newTimer));
  assert.equal(state.options.fallbackPollRef.current, undefined);
  assert.equal(requests.length, requestCount);
});

test("current approvals, cancellation and terminal snapshots still settle normally", async (t) => {
  await t.test("approval resumes current observation", async (t) => {
    const state = observationState("A", "approval_needed");
    const starts = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => Response.json(
      init?.method === "POST"
        ? { run: run("A", "running") }
        : { conversation: conversation("A", "running") },
    ));
    await confirmations.decideRunConfirmation({
      ...state.options,
      app: state.app,
      currentRunId: "A-run",
      decision: "approve_once",
      confirmationBusy: false,
      refreshConversations: async () => {},
      startLiveUpdates: (subscription) => starts.push(subscription),
    });
    assert.equal(state.app.run.status, "running");
    assert.equal(state.confirmationBusy, false);
    assert.deepEqual(starts, [{
      runId: "A-run", conversationId: "A", epoch: 1, cursor: "A-cursor",
    }]);
  });
  await t.test("approval completion", async (t) => {
    const state = observationState("A", "approval_needed");
    const starts = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => Response.json(
      init?.method === "POST"
        ? { run: run("A", "completed") }
        : { conversation: conversation("A", "completed") },
    ));
    await confirmations.decideRunConfirmation({
      ...state.options,
      app: state.app,
      currentRunId: "A-run",
      decision: "approve_once",
      confirmationBusy: false,
      refreshConversations: async () => {},
      startLiveUpdates: (subscription) => starts.push(subscription),
    });
    assert.equal(state.app.run.status, "completed");
    assert.equal(state.app.detail.status, "completed");
    assert.equal(state.confirmationBusy, false);
    assert.deepEqual(starts, []);
  });
  await t.test("cancellation", async (t) => {
    installBrowserPrimitives(t);
    const state = observationState("A");
    t.mock.method(globalThis, "fetch", async (url, init) => {
      if (init?.method === "POST") return Response.json({ run: run("A", "cancelled") });
      if (url === "/api/conversations") return Response.json({ conversations: [] });
      return Response.json(url.startsWith("/api/ordinary/")
        ? { view: view("A", "cancelled") }
        : { conversation: conversation("A", "cancelled") });
    });
    await controllers.createAppRunController(state.options).cancelRun();
    await flush();
    assert.equal(state.app.run.status, "cancelled");
    assert.equal(state.app.detail.status, "cancelled");
    assert.equal(state.options.activeRunIdRef.current, "A-run");
    assert.equal(state.cancellingRunId, undefined);
  });
  for (const status of ["completed", "cancelled"]) {
    await t.test(`terminal snapshot: ${status}`, async (t) => {
      installBrowserPrimitives(t);
      const state = observationState("A");
      t.mock.method(globalThis, "fetch", async (url) => {
        if (url === "/api/conversations/A") return Response.json({ conversation: conversation("A", status) });
        return Response.json({ view: view("A", status) });
      });
      observations.createLiveRunUpdateController(state.options).startLiveUpdates({
        runId: "A-run", conversationId: "A", epoch: 1,
      });
      const stream = state.options.streamRef.current;
      await flush();
      assert.equal(state.app.run.status, status);
      assert.equal(state.app.detail.status, status);
      assert.equal(state.app.live, undefined);
      assert.equal(stream.closed, true);
      assert.equal(state.options.pollTimer.current, undefined);
    });
  }
  for (const status of ["approval_needed", "completed", "cancelled"]) {
    await t.test(`current polling settles normally: ${status}`, async (t) => {
      installBrowserPrimitives(t);
      const state = observationState("A");
      t.mock.method(globalThis, "fetch", async (url) => {
        if (url === "/api/conversations/A") return Response.json({ conversation: conversation("A", status) });
        return Response.json({ view: view("A", status) });
      });
      observations.createLiveRunUpdateController(state.options).startPolling({
        runId: "A-run", conversationId: "A", epoch: 1,
      });
      const request = state.options.fallbackPollRef.current;
      await flush();
      assert.equal(request.signal.aborted, true);
      assert.equal(state.app.run.status, status);
      assert.equal(state.app.detail.status, status);
      assert.equal(state.app.live, undefined);
      assert.equal(state.options.pollTimer.current, undefined);
      assert.equal(state.options.fallbackPollRef.current, undefined);
    });
  }
  await t.test("current stream failure falls back to polling", async (t) => {
    installBrowserPrimitives(t);
    const state = observationState("A");
    const requests = [];
    t.mock.method(globalThis, "fetch", async () => {
      const pending = deferred();
      requests.push(pending);
      return pending.promise;
    });
    observations.createLiveRunUpdateController(state.options).startLiveUpdates({
      runId: "A-run", conversationId: "A", epoch: 1,
    });
    const stream = state.options.streamRef.current;
    stream.onerror();
    assert.equal(stream.closed, true);
    assert.equal(state.options.streamRef.current, undefined);
    assert.equal(requests.length, 2);
    requests[1].resolve(Response.json({ view: view("A", "running") }));
    requests[0].reject(new Error("retired bootstrap failed"));
    await flush();
    assert.equal(state.app.run.status, "running");
    assert.equal(state.app.detail.status, "running");
    assert.equal(state.options.activeRunIdRef.current, "A-run");
    assert.equal(state.options.fallbackPollRef.current, undefined);
    assert.notEqual(state.options.pollTimer.current, undefined);
    assert.equal(requests.length, 2);
  });
});

function observationState(id, status = "running") {
  const state = {
    app: {
      conversation: conversation(id, status),
      run: run(id, status),
      workView: { ...view(id, status).workView, pendingConfirmation: { confirmationId: `${id}-approval` } },
      detail: view(id, status).detail,
      transcriptNodes: [], transcriptNodesByRunId: {}, events: [], conversations: [], busy: false,
    },
    confirmationBusy: false,
    cancellingRunId: undefined,
  };
  state.options = {
    app: state.app,
    mountedRef: { current: true },
    activeRunIdRef: { current: `${id}-run` },
    viewEpochRef: { current: 1 },
    pollTimer: { current: undefined },
    streamRef: { current: undefined },
    fallbackPollRef: { current: undefined },
    setApp: (update) => { state.app = update(state.app); },
    setConfirmationBusy: (busy) => { state.confirmationBusy = busy; },
    setCancellingRunId: (update) => {
      state.cancellingRunId = typeof update === "function" ? update(state.cancellingRunId) : update;
    },
    refreshConversations: async () => {},
  };
  state.navigate = (nextId) => {
    state.options.viewEpochRef.current += 1;
    state.options.activeRunIdRef.current = `${nextId}-run`;
    state.app = observationState(nextId).app;
  };
  return state;
}

function run(id, status = "running") {
  return { runId: `${id}-run`, conversationId: id, status, eventCursor: { lastSequence: 1 } };
}

function view(id, status = "running") {
  const current = run(id, status);
  return {
    run: current,
    workView: { run: current, transcriptNodes: [] },
    detail: { runId: current.runId, status, transcript: { transcriptNodes: [] }, toolResults: [] },
    replay: { reset: false, events: [], cursor: { token: `${id}-cursor`, lastSequence: 1 } },
  };
}

function conversation(id, status = "running") {
  return { conversationId: id, turns: [], currentRun: view(id, status), latestRunId: `${id}-run` };
}

function event(id, type, sequence) {
  return { id: `${id}-event-${sequence}`, runId: `${id}-run`, sequence, type, refs: [] };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

function installBrowserPrimitives(t) {
  let sequence = 0;
  const callbacks = new Map();
  const schedule = (callback) => { const id = ++sequence; callbacks.set(id, callback); return id; };
  installGlobal(t, "window", {
    setInterval: schedule, clearInterval: (id) => callbacks.delete(id),
    setTimeout: schedule, clearTimeout: (id) => callbacks.delete(id),
  });
  installGlobal(t, "EventSource", FakeEventSource);
  return { callbacks };
}

function installGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => {
    if (previous === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, previous);
  });
}

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  close() {
    this.closed = true;
  }

  emit(type, value = {}, cursor = "") {
    this.listeners.get(type)?.({ data: JSON.stringify(value), lastEventId: cursor });
  }
}
