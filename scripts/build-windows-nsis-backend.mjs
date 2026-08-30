import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run() {
  if (process.platform !== "win32") throw new Error("The Windows NSIS backend can only be built on Windows.");
  const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const temporaryRoot = path.resolve(os.tmpdir());
  const outputDirectory = mkdtempSync(path.join(temporaryRoot, "synech-installer-backend-"));
  try {
    execFileSync(process.env.ComSpec ?? "cmd.exe", [
      "/d", "/s", "/c",
      `pnpm exec electron-builder --win nsis --x64 --publish never --config.directories.output="${outputDirectory}"`,
    ], { cwd: projectRoot, stdio: "inherit" });
    const expectedInstaller = `Synech-Setup-${packageJson.version}-x64.exe`;
    const installer = path.join(outputDirectory, expectedInstaller);
    if (!existsSync(installer)) throw new Error(`electron-builder did not produce ${expectedInstaller}.`);
    const releaseDirectory = path.join(projectRoot, "release", "installer-backend");
    mkdirSync(releaseDirectory, { recursive: true });
    copyFileSync(installer, path.join(releaseDirectory, expectedInstaller));
    const blockMap = `${installer}.blockmap`;
    if (existsSync(blockMap)) copyFileSync(blockMap, path.join(releaseDirectory, `${expectedInstaller}.blockmap`));
    const metadata = path.join(outputDirectory, "latest.yml");
    if (existsSync(metadata)) copyFileSync(metadata, path.join(releaseDirectory, "latest.yml"));
    const unpackedDirectory = path.join(outputDirectory, "win-unpacked");
    if (!existsSync(unpackedDirectory)) throw new Error("electron-builder did not produce win-unpacked installation metadata.");
    const requiredBytes = directorySize(unpackedDirectory);
    writeFileSync(path.join(releaseDirectory, "installer-metadata.json"), `${JSON.stringify({
      requiredBytes,
    }, null, 2)}\n`);
  } finally {
    const resolvedOutput = path.resolve(outputDirectory);
    if (resolvedOutput.startsWith(`${temporaryRoot}${path.sep}`)) rmSync(resolvedOutput, { recursive: true, force: true });
  }
}

function directorySize(directory) {
  return readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const entryPath = path.join(directory, entry.name);
    return total + (entry.isDirectory() ? directorySize(entryPath) : statSync(entryPath).size);
  }, 0);
}

run();
