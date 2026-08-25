import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(path.resolve(
  "src/app/panel-ui/src/workbench/navigation-state.ts",
)).href;

test("navigation reducer keeps search return target and clears stale surface selections", () => {
  const result = runStripTypes(`
    import {
      createInitialWorkbenchNavigationState,
      reduceWorkbenchNavigation,
    } from ${JSON.stringify(moduleUrl)};
    let state = createInitialWorkbenchNavigationState();
    state = reduceWorkbenchNavigation(state, { type: "set-brain-selection", id: "note-1" });
    state = reduceWorkbenchNavigation(state, { type: "set-space-target", id: "reference-1" });
    state = reduceWorkbenchNavigation(state, { type: "navigate", target: "brain" });
    state = reduceWorkbenchNavigation(state, { type: "navigate", target: "search" });
    console.log(JSON.stringify(state));
  `);
  assert.deepEqual(result, {
    view: "search",
    previousView: "brain",
    brainSelectedId: null,
    spaceTargetId: null,
    activeSpaceId: null,
    homeOwnerSelection: null,
    homeFocusRequest: 0,
    conversationSurfaceRequest: null,
  });
});

test("navigation reducer preserves valid context and replaces removed context", () => {
  const result = runStripTypes(`
    import {
      createInitialWorkbenchNavigationState,
      reduceWorkbenchNavigation,
    } from ${JSON.stringify(moduleUrl)};
    let state = createInitialWorkbenchNavigationState();
    state = reduceWorkbenchNavigation(state, { type: "set-active-space", id: "space-2" });
    state = reduceWorkbenchNavigation(state, { type: "set-home-owner", owner: { kind: "workspace", id: "workspace-1" } });
    state = reduceWorkbenchNavigation(state, {
      type: "sync-context-selection",
      spaceIds: ["space-1", "space-2"],
      workspaceIds: ["workspace-1"],
    });
    const preserved = { activeSpaceId: state.activeSpaceId, homeOwnerSelection: state.homeOwnerSelection };
    state = reduceWorkbenchNavigation(state, {
      type: "sync-context-selection",
      spaceIds: ["space-3"],
      workspaceIds: [],
    });
    console.log(JSON.stringify({ preserved, replaced: { activeSpaceId: state.activeSpaceId, homeOwnerSelection: state.homeOwnerSelection } }));
  `);
  assert.deepEqual(result, {
    preserved: {
      activeSpaceId: "space-2",
      homeOwnerSelection: { kind: "workspace", id: "workspace-1" },
    },
    replaced: {
      activeSpaceId: "space-3",
      homeOwnerSelection: { kind: "space", id: "space-3" },
    },
  });
});

test("navigation reducer records focus requests and conversation presentation", () => {
  const result = runStripTypes(`
    import {
      createInitialWorkbenchNavigationState,
      reduceWorkbenchNavigation,
    } from ${JSON.stringify(moduleUrl)};
    let state = createInitialWorkbenchNavigationState();
    state = reduceWorkbenchNavigation(state, { type: "focus-home-input" });
    state = reduceWorkbenchNavigation(state, {
      type: "set-conversation-surface",
      request: { conversationId: "conversation-1", spaceId: "space-1" },
    });
    console.log(JSON.stringify(state));
  `);
  assert.equal(result.homeFocusRequest, 1);
  assert.deepEqual(result.conversationSurfaceRequest, {
    conversationId: "conversation-1",
    spaceId: "space-1",
  });
});

test("an explicit Space target is applied after navigation clears stale targets", () => {
  const result = runStripTypes(`
    import {
      createInitialWorkbenchNavigationState,
      reduceWorkbenchNavigation,
    } from ${JSON.stringify(moduleUrl)};
    let state = createInitialWorkbenchNavigationState();
    state = reduceWorkbenchNavigation(state, { type: "set-space-target", id: "old-reference" });
    state = reduceWorkbenchNavigation(state, { type: "navigate", target: "space" });
    state = reduceWorkbenchNavigation(state, { type: "set-space-target", id: "reference-2" });
    console.log(JSON.stringify(state));
  `);
  assert.equal(result.spaceTargetId, "reference-2");
});

function runStripTypes(source) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
