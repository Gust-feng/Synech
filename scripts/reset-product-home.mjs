import { lstat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";

const args = parseArgs(process.argv.slice(2));
const target = resolveProductHome(args.home);
assertSafeProductHome(target);

console.log(`Synech Product Home reset target:\n${target}`);
const exists = await lstat(target).then(() => true, (error) => {
  if (error?.code === "ENOENT") return false;
  throw error;
});
if (!exists) {
  console.log("Nothing to reset; the Product Home does not exist.");
  process.exit(0);
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

await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
console.log(`Removed Synech Product Home: ${target}`);

function parseArgs(values) {
  let home;
  let confirm;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--home") home = requireNext(values, ++index, "--home");
    else if (value.startsWith("--home=")) home = value.slice("--home=".length);
    else if (value === "--confirm") confirm = requireNext(values, ++index, "--confirm");
    else if (value.startsWith("--confirm=")) confirm = value.slice("--confirm=".length);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return { home: nonBlank(home), confirm: nonBlank(confirm) };
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
