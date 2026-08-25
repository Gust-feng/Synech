import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { startLocalPanelServer } from "../dist/app/panel-server/request-handler.js";

const baseline = JSON.parse(await fs.readFile(new URL("../docs/architecture/data-baseline.json", import.meta.url), "utf8"));

test("fresh Product Home matches the frozen v1 data baseline", async () => {
  await withTemporaryDirectory(async (temporaryDirectory) => {
    const productHome = path.join(temporaryDirectory, "product-home");
    const server = await startLocalPanelServer({ productHome, port: 0 });
    await server.close();
    const database = new DatabaseSync(path.join(productHome, "data", "synech.sqlite3"), { readOnly: true });
    try {
      const identity = database.prepare(
        "SELECT product_namespace AS productNamespace, data_format_id AS dataFormatId FROM product_identity",
      ).get();
      assert.deepEqual({ ...identity }, {
        productNamespace: baseline.productNamespace,
        dataFormatId: baseline.dataFormatId,
      });
      const migrations = Object.fromEntries(database.prepare(
        "SELECT owner, version FROM schema_migrations ORDER BY owner",
      ).all().map((row) => [row.owner, row.version]));
      assert.deepEqual(migrations, baseline.migrationOwners);

      const schema = database.prepare(
        "SELECT type, name, tbl_name AS tblName, sql FROM sqlite_master WHERE name NOT LIKE ? ORDER BY type, name",
      ).all("sqlite_%");
      const fingerprint = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
      assert.equal(fingerprint, baseline.schemaFingerprint);

      const noteColumns = database.prepare("PRAGMA table_info(personal_notes)").all();
      assert.equal(noteColumns.find((column) => column.name === "space_id")?.notnull, 0);
      assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'workspace_links'").get(), undefined);
    } finally {
      database.close();
    }
  });
});

test("Product Home reset requires an exact explicit target confirmation", async () => {
  await withTemporaryDirectory(async (temporaryDirectory) => {
    const productHome = path.join(temporaryDirectory, "disposable-product-home");
    await fs.mkdir(productHome, { recursive: true });
    await fs.writeFile(path.join(productHome, "marker.txt"), "remove me", "utf8");

    const rejected = await run(process.execPath, [
      "scripts/reset-product-home.mjs",
      "--home", productHome,
      "--confirm", path.join(temporaryDirectory, "wrong-home"),
    ]);
    assert.notEqual(rejected.code, 0);
    assert.equal(await exists(productHome), true);

    const accepted = await run(process.execPath, [
      "scripts/reset-product-home.mjs",
      "--home", productHome,
      "--confirm", path.resolve(productHome),
    ]);
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.equal(await exists(productHome), false);
  });
});

async function withTemporaryDirectory(operation) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-data-baseline-"));
  try { await operation(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function exists(target) {
  return await fs.stat(target).then(() => true, (error) => error?.code === "ENOENT" ? false : Promise.reject(error));
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
