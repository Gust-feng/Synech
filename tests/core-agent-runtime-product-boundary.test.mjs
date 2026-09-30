import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PRODUCT_ROOTS = [
  "src/app",
  "src/domain",
  "src/kernel",
];

const PI_PACKAGES = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
];

const PI_IDENTIFIERS = [
  "AgentHarness",
  "AgentLane",
  "AgentHarnessEvent",
  "HarnessEvent",
  "OperationResultRecord",
];

function walk(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      // panel-ui is a separately compiled frontend package and is checked by its own tsconfig.
      if (entry.name === "panel-ui" || entry.name === "panel-demo") continue;
      files.push(...walk(full));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".cts")) files.push(full);
  }
  return files;
}

function productFiles() {
  return PRODUCT_ROOTS.flatMap((root) => {
    try {
      return walk(root);
    } catch {
      return [];
    }
  });
}

/** Scan code only: boundary documentation in comments is desirable, not a leak. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

test("the product layer never imports the pi runtime provider", () => {
  const offenders = [];
  for (const file of productFiles()) {
    const source = readFileSync(file, "utf8");
    for (const pkg of PI_PACKAGES) {
      if (source.includes(`from "${pkg}`) || source.includes(`from '${pkg}`)) {
        offenders.push(`${relative(process.cwd(), file)} imports ${pkg}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "product layer must reach pi only through the adapter boundary");
});

test("product contracts never name pi runtime objects or identities", () => {
  const offenders = [];
  for (const file of productFiles()) {
    const source = withoutComments(readFileSync(file, "utf8"));
    for (const identifier of PI_IDENTIFIERS) {
      const pattern = new RegExp(`\\b${identifier}\\b`);
      if (pattern.test(source)) {
        offenders.push(`${relative(process.cwd(), file)} references ${identifier}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "pi runtime types belong to the pi adapter");
});

test("the product runtime contract stays free of pi entry identity", () => {
  const source = withoutComments(readFileSync(
    new URL("../src/app/model-runtime/agent-loop.ts", import.meta.url),
    "utf8",
  ));
  for (const leaked of ["entryId", "tipId", "operationId", "usageId", "lane", "branch"]) {
    assert.ok(!source.includes(leaked), `the agent runtime port must not name pi identity ${leaked}`);
  }
});

test("the product runtime port is the existing AgentLoop, not a second provider", () => {
  // A second, unwired provider interface would be a parallel runtime. The
  // boundary is the existing AgentLoop plus the session checkpoint contract.
  const port = withoutComments(readFileSync(
    new URL("../src/app/model-runtime/agent-loop.ts", import.meta.url),
    "utf8",
  ));
  assert.ok(port.includes("export interface AgentLoop"), "AgentLoop must remain the product runtime port");
  for (const missing of [
    "createRun",
    "decideApprovals",
    "subscribe",
    "AgentRuntimeProvider",
    "AgentRuntimeRun",
  ]) {
    assert.ok(!port.includes(missing), `the product runtime port must not declare the parallel ${missing} surface`);
  }
});

test("the product session port speaks only product checkpoint identity", () => {
  const source = withoutComments(readFileSync(
    new URL("../src/app/model-runtime/agent-session.ts", import.meta.url),
    "utf8",
  ));
  for (const leaked of ["entryId", "entryRef", "AgentSessionEntryRef", "AgentSessionLeafPosition", "leafRef"]) {
    assert.ok(!source.includes(leaked), `product session port must not name provider entry identity ${leaked}`);
  }
  for (const required of [
    "checkpointId",
    "locateSessionCheckpoints",
    "moveActiveCheckpoint",
    "readAssistantEntriesByCheckpoint",
    "reconcileToolResultEntries",
  ]) {
    assert.ok(source.includes(required), `product session port must expose ${required}`);
  }
});

test("durable Ordinary run state stores product checkpoints, not provider entries", () => {
  const files = [
    "contracts.ts",
    "state.ts",
    "terminal-settlement.ts",
    "activity-replay.ts",
    "session-branch-recovery.ts",
    "conversation-projection.ts",
    "file-system-repository.ts",
  ];
  for (const file of files) {
    const source = withoutComments(readFileSync(
      new URL(`../src/app/ordinary-agent/${file}`, import.meta.url),
      "utf8",
    ));
    for (const leaked of ["entryId", "entryRef", "EntryRef", "leafRef", "LeafRef"]) {
      assert.ok(
        !source.includes(leaked),
        `ordinary-agent/${file} must not persist or branch on provider entry identity ${leaked}`,
      );
    }
  }
});

test("the pi adapter owns every remaining pi dependency in the intelligence adapter", () => {
  const adapters = readdirSync(new URL("../src/adapters/intelligence", import.meta.url), {
    withFileTypes: true,
  });
  assert.ok(adapters.some((entry) => entry.name === "pi-agent"),
    "pi-agent adapter directory must exist as the provider boundary");
  const root = new URL("../src/adapters/intelligence/pi-agent/", import.meta.url);
  assert.ok(statSync(root).isDirectory(), "pi adapter boundary must be a directory");
});

test("Panel run composition delegates checkpoint identity mapping to the adapter", () => {
  const source = withoutComments(readFileSync(
    new URL("../src/app/panel-server/ordinary/ordinary-agent-run-resources.ts", import.meta.url),
    "utf8",
  ));
  for (const leaked of ["TranscriptEntryRef", "entryRef", "entryId", "recordSessionCheckpoint"]) {
    assert.ok(!source.includes(leaked), `Panel composition must not handle provider checkpoint identity ${leaked}`);
  }
  assert.ok(source.includes("createAgentSessionCheckpointPort"),
    "Panel composition should pass the writer capability through the adapter-owned port");
});
