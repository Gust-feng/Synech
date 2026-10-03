import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveProductHome, resolveProductPaths } from "../dist/platform/storage/index.js";
import { isWithinRoot, normalizeRelativePath } from "../dist/app/local-filesystem/index.js";
import { resolveDefaultSubAgentRoots } from "../dist/app/panel-server/storage/runtime-asset-roots.js";
import { discoverSubAgents, loadSubAgentBody } from "../dist/app/sub-agents/sub-agent-loader.js";
import { writeHtml } from "../dist/app/panel-server/http-utils.js";

test("Product Home has one canonical root and stable owned paths", () => {
  assert.equal(resolveProductHome({ productHome: "C:/data/synech" }), "C:\\data\\synech");
  assert.equal(resolveProductHome({ env: { SYNECH_HOME: "C:/configured" } }), "C:\\configured");
  const paths = resolveProductPaths({ productHome: "C:/data/synech" });
  assert.equal(paths.data.database, "C:\\data\\synech\\data\\synech.sqlite3");
  assert.equal(paths.state.journals, "C:\\data\\synech\\state\\journals");
  assert.equal(paths.cache.commandLogs, "C:\\data\\synech\\cache\\command-logs");
});

test("filesystem boundaries reject traversal and prefix lookalikes", () => {
  assert.equal(isWithinRoot("C:/work", "C:/work/file.txt"), true);
  assert.equal(isWithinRoot("C:/work", "C:/workspace/file.txt"), false);
  assert.throws(() => normalizeRelativePath("../escape.txt"));
});

test("the production default root discovers all shipped sub-agents", async () => {
  const root = resolveDefaultSubAgentRoots().find((entry) => entry.sourceKind === "builtin");
  assert.equal(root.rootPath, resolve("dist/app/sub-agents/builtin"));
  const packages = (await readdir("src/app/sub-agents/builtin", { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.ok(packages.length > 0);
  const agents = await discoverSubAgents({ roots: [root] });
  assert.deepEqual(agents.map((agent) => agent.packageName).sort(), packages);
  for (const agent of agents) {
    assert.equal(agent.loadError, undefined);
    assert.equal(agent.enabled, true);
    assert.ok((await loadSubAgentBody(agent)).length > 0);
  }
});

test("production HTML permits local image previews without broadening other sources", async (t) => {
  const server = createServer((_request, response) => writeHtml(response, "<!doctype html><title>Panel</title>"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  await response.text();
  const directives = new Map(response.headers.get("content-security-policy").split(";").map((directive) => {
    const [name, ...sources] = directive.trim().split(/\s+/u);
    return [name, sources];
  }));
  assert.deepEqual(directives.get("img-src"), ["'self'", "data:", "blob:"]);
  assert.deepEqual(directives.get("default-src"), ["'self'"]);
  assert.deepEqual(directives.get("connect-src"), ["'self'"]);
  assert.deepEqual(directives.get("script-src"), ["'self'", "'unsafe-inline'"]);
});
