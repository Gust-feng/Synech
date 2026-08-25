import assert from "node:assert/strict";
import test from "node:test";
import { createSpaceReferenceLifecycleApplication } from "../dist/app/application/space-reference-lifecycle-application.js";

test("Space Reference lifecycle application owns canonical relationship mutations", async () => {
  const events = [];
  const item = { id: "reference-1", spaceId: "space-1", title: "old", reference: { kind: "local_file", path: "C:/old.txt" } };
  const app = createSpaceReferenceLifecycleApplication({
    spaceFeature: {
      commands: {
        async addReference(input) { events.push(["add", input.spaceId]); return { ...item, ...input, id: "reference-2" }; },
        async move(input) { events.push(["move", input.destinationSpaceId]); },
        async rename(input) { events.push(["rename", input.target.id]); return { kind: input.target.kind, id: input.target.id }; },
        async removeReference(id) { events.push(["remove", id]); },
      },
      queries: {
        async getReference() { return item; },
        async getTree() { return { entries: [{ item }] }; },
      },
    },
    spaceAdmission: { async admit(id, operation) { events.push(["admit", id]); return await operation(); } },
    workbenchCoordination: { commands: {} },
    async unlinkExternalReference(id) { events.push(["unlink", id]); },
  });
  await app.addReference({ spaceId: "space-1", title: "new", reference: item.reference, actor: { kind: "user" } });
  await app.move({ sourceSpaceId: "space-1", target: { kind: "reference", id: item.id }, destinationSpaceId: "space-2" });
  await app.rename({ target: { kind: "reference", id: item.id }, title: "new" });
  await app.remove({ itemId: item.id });
  await app.unlink({ itemId: item.id });
  assert.deepEqual(events.map(([kind]) => kind), ["admit", "add", "admit", "admit", "move", "admit", "rename", "admit", "remove", "unlink"]);
});
