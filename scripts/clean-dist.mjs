import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(repoRoot, "dist");

if (!distDir.startsWith(`${repoRoot}${"\\"}`) && !distDir.startsWith(`${repoRoot}/`)) {
  throw new Error(`Refusing to remove a path outside the repository: ${distDir}`);
}

await rm(distDir, {
  force: true,
  recursive: true,
  maxRetries: 10,
  retryDelay: 100,
});
