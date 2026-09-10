import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkSqliteDatabaseFile } from "../dist/adapters/runtime-storage/index.js";
import { startLocalPanelServer } from "../dist/app/panel-server/request-handler.js";
import { PRODUCT_DATA_FORMAT_ID, PRODUCT_NAMESPACE } from "../dist/platform/product-identity.js";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  throw new Error("Usage: node scripts/update-data-baseline.mjs [--check] (run pnpm build:node first)");
}
const manifestPath = fileURLToPath(new URL("../docs/architecture/data-baseline.json", import.meta.url));
const temporaryRoot = path.resolve(os.tmpdir());
const productHome = await mkdtemp(path.join(temporaryRoot, "synech-schema-"));
let server;
try {
  // Use the production composition root so new owners cannot be silently omitted.
  server = await startLocalPanelServer({ productHome, host: "127.0.0.1", port: 0 });
  await server.close();
  server = undefined;
  const database = checkSqliteDatabaseFile(path.join(productHome, "data", "synech.sqlite3"));
  assert.equal(database.ok, true);
  assert.equal(database.productNamespace, PRODUCT_NAMESPACE);
  assert.equal(database.dataFormatId, PRODUCT_DATA_FORMAT_ID);
  const migrationOwners = {};
  const migrationChecksums = {};
  for (const migration of database.migrations) {
    migrationOwners[migration.owner] = Math.max(migrationOwners[migration.owner] ?? 0, migration.version);
    migrationChecksums[`${migration.owner}/${migration.version}`] = migration.checksum;
  }
  const baseline = {
    productNamespace: PRODUCT_NAMESPACE,
    dataFormatId: PRODUCT_DATA_FORMAT_ID,
    schemaFingerprint: database.schemaFingerprint,
    migrationOwners,
    migrationChecksums,
  };
  if (args[0] === "--check") {
    assert.deepEqual(baseline, JSON.parse(await readFile(manifestPath, "utf8")),
      "Current schema differs from data-baseline.json; regenerate the released baseline");
    console.log("Current database schema matches the released baseline.");
  } else {
    await writeFile(manifestPath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log("Updated the released database baseline.");
  }
} finally {
  try {
    await server?.close();
  } finally {
    const resolved = path.resolve(productHome);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith("synech-schema-"));
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
