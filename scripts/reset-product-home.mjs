import { lstat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";

const runtimeLeaseModule = await import(pathToFileURL(
  process.env.SYNECH_RUNTIME_LEASE_MODULE ??
    path.resolve("dist/app/panel-server/product-home-runtime-lease.js"),
));

await main();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveProductHome(args.home);
  assertSafeProductHome(target);

  let lease;
  try {
    lease = await runtimeLeaseModule.acquireProductHomeRuntimeLease(target);
  } catch (error) {
    if (error?.code === "product_home_in_use") {
      console.error(JSON.stringify({
        ok: false,
        status: "rejected",
        code: error.code,
        productHome: target,
        holder: error.holder,
      }, null, 2));
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  try {
    console.log(`Synech ${args.dataOnly ? "test-data" : "Product Home"} reset target:\n${target}`);
    const exists = await lstat(target).then(() => true, (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
    if (exists && (await lstat(target)).isSymbolicLink()) {
      throw new Error("Refusing to reset a symlink or junction Product Home.");
    }
    if (!exists) {
      console.log("Nothing to reset; the Product Home does not exist.");
      return;
    }

    let confirmation = args.confirm;
    if (confirmation === undefined) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("Interactive confirmation is unavailable. Pass --confirm with the exact absolute target path.");
      }
      const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        confirmation = (await prompt.question("Type the exact absolute path above to confirm deletion:\n> ")).trim();
      } finally {
        prompt.close();
      }
    }
    if (path.resolve(confirmation) !== target) {
      throw new Error("Confirmation did not exactly match the resolved Synech Product Home; nothing was deleted.");
    }

    if (args.dataOnly) {
      const dataRoot = path.resolve(target, "data");
      const journalsRoot = path.resolve(target, "state", "journals");
      const restoreMarkersRoot = path.resolve(target, "state", "restore-markers");
      // Drop incompatible test content and lifecycle intents together. Config,
      // credentials, external workspace files and runtime lease state stay intact.
      for (const candidate of [dataRoot, journalsRoot, restoreMarkersRoot]) {
        assertContainedTarget(target, candidate);
        const parent = await lstat(path.dirname(candidate)).catch((error) => {
          if (error?.code === "ENOENT") return undefined;
          throw error;
        });
        if (parent?.isSymbolicLink()) throw new Error(`Refusing to reset through a symlink or junction: ${candidate}`);
        await rm(candidate, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        const remaining = await lstat(candidate).then(() => true, (error) => {
          if (error?.code === "ENOENT") return false;
          throw error;
        });
        if (remaining) throw new Error(`Test-data reset did not remove ${candidate}; no success is reported.`);
      }
      console.log(`Removed Synech test data and lifecycle state; preserved config: ${target}`);
    } else {
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      console.log(`Removed Synech Product Home: ${target}`);
    }
  } finally {
    await lease.release();
  }
}

function assertContainedTarget(root, target) {
  const relative = path.relative(root, target);
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to reset outside Product Home: ${target}`);
  }
}

function parseArgs(values) {
  let home;
  let confirm;
  let dataOnly = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--home") home = requireNext(values, ++index, "--home");
    else if (value.startsWith("--home=")) home = value.slice("--home=".length);
    else if (value === "--confirm") confirm = requireNext(values, ++index, "--confirm");
    else if (value.startsWith("--confirm=")) confirm = value.slice("--confirm=".length);
    else if (value === "--data-only") dataOnly = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return { home: nonBlank(home), confirm: nonBlank(confirm), dataOnly };
}

function requireNext(values, index, flag) {
  const value = values[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function resolveProductHome(explicitHome) {
  if (explicitHome !== undefined) return path.resolve(explicitHome);
  const configured = nonBlank(process.env.SYNECH_HOME);
  if (configured !== undefined) return path.resolve(configured);
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.resolve(nonBlank(process.env.LOCALAPPDATA) ?? path.join(home, "AppData", "Local"), "Synech");
  }
  if (process.platform === "darwin") return path.resolve(home, "Library", "Application Support", "Synech");
  return path.resolve(nonBlank(process.env.XDG_DATA_HOME) ?? path.join(home, ".local", "share"), "synech");
}

function assertSafeProductHome(value) {
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  const home = path.resolve(os.homedir());
  if (resolved === parsed.root || resolved === home || resolved.length <= parsed.root.length + 2) {
    throw new Error(`Refusing to reset a broad path: ${resolved}`);
  }
}

function nonBlank(value) {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
