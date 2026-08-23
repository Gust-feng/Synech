import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skipReleases = process.argv.includes("--skip-releases");

const generatedDirectories = [
  "build",
  "dist",
  "src/app/panel-ui/dist",
];

const rootEntries = await readdir(repoRoot, { withFileTypes: true });
const versionedReleaseDirectories = rootEntries
  .filter(
    (entry) =>
      entry.isDirectory() && /^release-\d+\.\d+\.\d+$/.test(entry.name),
  )
  .map((entry) => entry.name);
const rootLogFiles = rootEntries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
  .map((entry) => entry.name);

const codexRoot = resolve(repoRoot, ".codex");
const codexEntries = await readdir(codexRoot, { withFileTypes: true }).catch(
  () => [],
);
const codexLogFiles = codexEntries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
  .map((entry) => `.codex/${entry.name}`);

const cleanupTargets = [
  ...generatedDirectories,
  ...rootLogFiles,
  ...codexLogFiles,
  ".canvas-meta.json",
  ...(skipReleases ? [] : ["release", ...versionedReleaseDirectories]),
];

for (const cleanupTarget of cleanupTargets) {
  const absoluteTarget = resolve(repoRoot, cleanupTarget);
  const relativeTarget = relative(repoRoot, absoluteTarget);

  if (
    relativeTarget.length === 0 ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new Error(`Refusing to remove a path outside the repository: ${absoluteTarget}`);
  }

  const targetExists = await lstat(absoluteTarget).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    },
  );
  if (!targetExists) {
    continue;
  }

  await rm(absoluteTarget, {
    force: true,
    recursive: true,
    maxRetries: 3,
    retryDelay: 100,
  });
  console.log(`Removed ${relativeTarget}`);
}
