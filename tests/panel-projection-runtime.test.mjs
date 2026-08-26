import assert from "node:assert/strict";
import test from "node:test";

import { createPanelProjectionRuntime } from "../dist/app/panel-server/composition/panel-projection-runtime.js";

test("Panel projection runtime publishes owner changes and releases every subscription", () => {
  const spaces = eventSource();
  const personalKnowledge = eventSource();
  const managedAssets = eventSource();
  const workspaces = eventSource();
  const fileMutations = eventSource();
  const ordinary = stableTerminalSource();
  const runtime = createPanelProjectionRuntime({
    spaces: { events: spaces.events, queries: { async listReferencesByWorkspace() { return []; } } },
    personalKnowledge: { events: personalKnowledge.events },
    managedAssets: { events: managedAssets.events },
    workspaces: { events: workspaces.events },
    fileMutations: { events: fileMutations.events },
    ordinary: { events: ordinary.events },
    managedSpaceRoot: "C:/product/spaces",
  });
  const changes = [];
  runtime.changes.subscribe((change) => changes.push(change));

  managedAssets.emit({ type: "managed_asset.updated", assetId: "asset-1" });
  fileMutations.emit({});
  ordinary.emit();

  assert.deepEqual(changes.map((change) => change.owners), [
    ["managed_assets"],
    ["mounted_files"],
    ["mounted_files"],
  ]);
  assert.deepEqual(changes[0].managedAssetIds, ["asset-1"]);

  runtime.release();

  assert.equal([
    spaces,
    personalKnowledge,
    managedAssets,
    workspaces,
    fileMutations,
    ordinary,
  ].every((source) => source.listenerCount() === 0), true);
  assert.throws(() => runtime.changes.replay(), /released/u);
});

function eventSource() {
  const listeners = new Set();
  return {
    events: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(event) { for (const listener of [...listeners]) listener(event); },
    listenerCount() { return listeners.size; },
  };
}

function stableTerminalSource() {
  const listeners = new Set();
  return {
    events: {
      subscribeStableTerminalRuns(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit() { for (const listener of [...listeners]) listener({}); },
    listenerCount() { return listeners.size; },
  };
}
