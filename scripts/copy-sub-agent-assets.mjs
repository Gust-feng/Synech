import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcBuiltinRoot = resolve(repoRoot, "src", "app", "sub-agents", "builtin");
const distBuiltinRoot = resolve(repoRoot, "dist", "app", "sub-agents", "builtin");

await mkdir(distBuiltinRoot, { recursive: true });

const entries = await readdir(srcBuiltinRoot, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const src = resolve(srcBuiltinRoot, entry.name);
  const dest = resolve(distBuiltinRoot, entry.name);
  await cp(src, dest, { recursive: true });
}
