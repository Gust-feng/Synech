import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";
import { createServer } from "vite";

let server;
let createToolSettingsController;
let reconcileWebSearchForm;
let webSearchFormFromConfig;

before(async () => {
  server = await createServer({
    configFile: false,
    root: path.resolve(import.meta.dirname, ".."),
    cacheDir: ".tmp/settings-save-test-cache",
    resolve: { alias: { "@panel-api": path.resolve(import.meta.dirname, "../src/app/panel-api") } },
    server: { middlewareMode: true, hmr: false, watch: null },
    logLevel: "error",
  });
  ({ createToolSettingsController } = await server.ssrLoadModule("/src/app/panel-ui/src/features/settings/controllers/tool-controller.ts"));
  ({ reconcileWebSearchForm, webSearchFormFromConfig } = await server.ssrLoadModule("/src/app/panel-ui/src/features/settings/config-projection.ts"));
});

after(async () => { await server?.close(); });

test("queued search saves preserve later provider edits and isolate pending state", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", (url, init) => new Promise((resolve) => {
    requests.push({ url, body: JSON.parse(init.body), resolve });
  }));
  const state = settingsState();
  const controller = createToolSettingsController(state.options);
  const baseline = state.form;
  state.form = { ...baseline, provider: "exa", apiKey: "first-provider-key" };
  const first = controller.saveTools(state.form);
  await new Promise(setImmediate);
  assert.equal(state.pending.webSearch, true);
  assert.equal(state.pending.skillTrigger, false);
  assert.equal(state.pending.tools, false);

  state.form = { ...baseline, provider: "google", apiKey: "later-provider-key", engineId: "engine" };
  const latestDraft = state.form;
  const second = controller.saveTools(state.form);
  requests[0].resolve(savedSearchResponse(requests[0].body));
  await first;
  await new Promise(setImmediate);
  assert.equal(state.form, latestDraft);
  assert.equal(reconcileWebSearchForm(state.form, baseline, webSearchFormFromConfig(state.app.tools.tools.webSearch)), latestDraft);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.provider, "google");
  assert.equal(requests[1].body.apiKey, "later-provider-key");

  requests[1].resolve(savedSearchResponse(requests[1].body));
  await second;
  assert.deepEqual(state.form, { ...latestDraft, apiKey: "" });
  assert.equal(state.app.tools.tools.webSearch.provider, "google");
  assert.equal(state.pending.webSearch, false);
  assert.equal(state.pending.tools, false);
  assert.equal(state.pending.skillTrigger, false);
});

test("a failed search save retains its editable draft without disabling other settings", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Save unavailable"); });
  const state = settingsState();
  state.form = { ...state.form, provider: "exa", apiKey: "unsaved-key" };
  const draft = state.form;
  await createToolSettingsController(state.options).saveTools(draft);
  assert.equal(state.form, draft);
  assert.equal(state.app.error, "Save unavailable");
  assert.deepEqual(state.pending, { tools: false, webSearch: false, skillTrigger: false });
});

function settingsState() {
  const state = {
    app: { tools: { tools: { webSearch: { provider: "tavily", maxResults: 5 } } } },
    form: { provider: "tavily", apiKey: "", maxResults: "5", engineId: "" },
    pending: { tools: false, webSearch: false, skillTrigger: false },
  };
  state.options = {
    app: state.app,
    toolForm: state.form,
    mountedRef: { current: true },
    toolSaveQueueRef: { current: Promise.resolve() },
    setApp: (update) => { state.app = update(state.app); },
    setToolForm: (update) => { state.form = update(state.form); },
    setSavingTools: (value) => { state.pending.tools = value; },
    setSavingWebSearch: (value) => { state.pending.webSearch = value; },
    setSavingSkillTrigger: (value) => { state.pending.skillTrigger = value; },
  };
  return state;
}

function savedSearchResponse(form) {
  return new Response(JSON.stringify({
    ok: true,
    tools: { webSearch: { provider: form.provider, maxResults: form.maxResults, engineId: form.engineId } },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}
