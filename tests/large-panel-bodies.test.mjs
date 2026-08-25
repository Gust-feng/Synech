import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startLocalPanelServer } from "../dist/app/panel-server/index.js";

test("Space documents and Personal Knowledge notes accept bodies above the default transport limit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synech-large-panel-body-"));
  const server = await startLocalPanelServer({ productHome: path.join(directory, "product"), port: 0 });
  try {
    const initialized = await fetch(new URL("api/spaces", server.url));
    assert.equal(initialized.status, 200);
    const relativePath = "Synech 快速开始.md";
    const previewResponse = await fetch(new URL(
      `api/spaces/references/builtin-my-space-getting-started/preview?path=${encodeURIComponent(relativePath)}`,
      server.url,
    ));
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()).preview;
    const text = "中".repeat(140_000);

    const update = await fetch(new URL(
      "api/spaces/references/builtin-my-space-getting-started/content",
      server.url,
    ), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relativePath, expectedFingerprint: preview.fingerprint, text }),
    });
    assert.equal(update.status, 200, await update.text());

    const note = await fetch(new URL("api/personal-knowledge/notes", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space-default", title: "Large note", bodyMarkdown: text }),
    });
    assert.equal(note.status, 201, await note.text());
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
