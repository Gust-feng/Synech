import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const stateModule = pathToFileURL(path.resolve(
  "src/app/panel-ui/src/personal-workbench/workbench/app/components/personalKnowledgeState.ts",
)).href;
const projectionModule = pathToFileURL(path.resolve(
  "src/app/panel-ui/src/features/spaces/projection.ts",
)).href;

test("Personal Knowledge save state is structured by status", () => {
  const result = runStripTypes(`
    import { createPersonalNoteSaveState } from ${JSON.stringify(stateModule)};
    console.log(JSON.stringify([
      createPersonalNoteSaveState(0, undefined),
      createPersonalNoteSaveState(1, undefined),
      createPersonalNoteSaveState(0, "冲突"),
    ]));
  `);
  assert.deepEqual(result, [
    { status: "saved" },
    { status: "saving" },
    { status: "error", message: "冲突" },
  ]);
});

test("Space projection keeps structured references and nested membership", () => {
  const result = runStripTypes(`
    import { projectSpaceTree } from ${JSON.stringify(projectionModule)};
    const tree = {
      space: { id: "space-1", title: "Project", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      entries: [
        { kind: "reference", item: {
          id: "folder-1", spaceId: "space-1", title: "Workspace", reference: { kind: "workspace", workspaceId: "workspace-1" },
          workspace: { status: "available", rootPath: "C:/project", mountVersion: "mount-1" }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        } },
        { kind: "reference", item: {
          id: "file-1", spaceId: "space-1", parentId: "folder-1", title: "README", reference: { kind: "local_file", path: "C:/project/README.md" },
          createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        } },
      ],
    };
    console.log(JSON.stringify(projectSpaceTree(tree, [{ conversationId: "conversation-1", title: "Review" }], Date.parse("2026-01-01T00:01:00.000Z"))));
  `);
  assert.equal(result.spaceId, "space-1");
  assert.equal(result.itemCount, 2);
  assert.equal(result.items[0].workspaceId, "workspace-1");
  assert.equal(result.items[0].children[0].kind, "local_file");
  assert.equal(result.items[0].children[0].detail, "C:/project/README.md");
  assert.deepEqual(result.conversations, [{ conversationId: "conversation-1", title: "Review" }]);
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
