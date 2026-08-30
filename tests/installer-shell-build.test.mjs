import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectInstallerShellAssets,
  demoInstallerArtifactName,
  installerRuntimeIdentity,
  outerInstallerArtifactName,
  renderEmbeddedShellAssetsHeader,
  resolveBackendArtifact,
  resolveInstallMetadata,
  validateInstallerShellDocument,
} from "../scripts/build-windows-installer-shell.mjs";

const sourceDocument = '<!doctype html><html><head><link rel="stylesheet" href="./assets/shell.css"></head><body><script type="module" src="./assets/shell.js"></script></body></html>';

test("installer shell preserves Vite entries for the native release directory", () => {
  const result = validateInstallerShellDocument(sourceDocument);
  assert.match(result, /href="\.\/assets\/shell\.css"/u);
  assert.match(result, /src="\.\/assets\/shell\.js"/u);
});

test("installer shell requires truthful unpacked installation size metadata", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "synech-installer-metadata-"));
  writeFileSync(path.join(directory, "installer-metadata.json"), JSON.stringify({ requiredBytes: 303_032_257 }));
  assert.deepEqual(resolveInstallMetadata(directory), { requiredBytes: 303_032_257 });
  writeFileSync(path.join(directory, "installer-metadata.json"), JSON.stringify({ requiredBytes: 0 }));
  assert.throws(() => resolveInstallMetadata(directory), /positive safe integer/u);
});

test("installer shell collects every runtime asset and creates a native mapping", () => {
  const webDirectory = mkdtempSync(path.join(tmpdir(), "synech-installer-web-"));
  const assetsDirectory = path.join(webDirectory, "assets");
  mkdirSync(path.join(assetsDirectory, "nested"), { recursive: true });
  for (const asset of [
    "completion-confetti.lottie",
    "dotlottie-player.wasm",
    "nested/dotlottie-runtime.js",
    "shell.css",
    "shell.js",
  ]) {
    writeFileSync(path.join(assetsDirectory, asset), asset);
  }

  const assets = collectInstallerShellAssets(webDirectory);
  assert.deepEqual(assets.map(({ resourceId, relativePath }) => ({ resourceId, relativePath })), [
    { resourceId: 103, relativePath: "assets/completion-confetti.lottie" },
    { resourceId: 104, relativePath: "assets/dotlottie-player.wasm" },
    { resourceId: 105, relativePath: "assets/nested/dotlottie-runtime.js" },
    { resourceId: 106, relativePath: "assets/shell.css" },
    { resourceId: 107, relativePath: "assets/shell.js" },
  ]);
  const header = renderEmbeddedShellAssetsHeader(assets);
  assert.match(header, /kEmbeddedShellAssets/u);
  assert.ok(header.includes('L"assets/nested/dotlottie-runtime.js"'));
  assert.match(header, /EmbeddedShellAsset\{107, L"assets\/shell\.js"\}/u);
});

test("installer shell rejects malformed or remote documents", () => {
  const valid = validateInstallerShellDocument(sourceDocument);
  assert.throws(
    () => validateInstallerShellDocument(`<!doctype html>${valid}`),
    /one HTML document/u,
  );
  assert.throws(
    () => validateInstallerShellDocument(valid.replace("./assets/shell.css", "https://cdn.example/shell.css")),
    /one local stylesheet/u,
  );
  assert.throws(
    () => validateInstallerShellDocument(valid.replace("./assets/shell.js", "https://cdn.example/shell.js")),
    /one local module entry/u,
  );
});

test("installer shell resolves only the embedded NSIS backend artifact", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "synech-installer-shell-"));
  const artifact = path.join(directory, "Synech-Setup-1.0.0-x64.exe");
  writeFileSync(artifact, "backend");
  assert.equal(resolveBackendArtifact(directory, "1.0.0"), artifact);
  assert.throws(() => resolveBackendArtifact(directory, "2.0.0"), /Missing NSIS backend/u);
});

test("installer shell can emit an explicit review artifact without changing the release name", () => {
  assert.equal(outerInstallerArtifactName("1.0.0"), "Synech-Installer-1.0.0-x64.exe");
  assert.equal(outerInstallerArtifactName("1.0.0", "review-5"), "Synech-Installer-1.0.0-x64-review-5.exe");
  assert.equal(demoInstallerArtifactName(), "Synech-Installer-Demo.exe");
  assert.equal(demoInstallerArtifactName("review-5"), "Synech-Installer-Demo-review-5.exe");
  assert.throws(() => outerInstallerArtifactName("1.0.0", "../review"), /suffix may contain only/u);
  assert.throws(() => demoInstallerArtifactName("../review"), /suffix may contain only/u);
});

test("review installers use an isolated runtime identity while release identity stays stable", () => {
  assert.deepEqual(installerRuntimeIdentity(), {
    mutexName: "Local\\Synech.InstallerShell",
    windowClass: "SynechInstallerShell",
    runtimeDirectoryName: "SynechInstaller",
  });
  assert.deepEqual(installerRuntimeIdentity("review-10"), {
    mutexName: "Local\\Synech.InstallerShell.review-10",
    windowClass: "SynechInstallerShell_review_10",
    runtimeDirectoryName: "SynechInstaller_review-10",
  });
  assert.notEqual(
    installerRuntimeIdentity("review-10").runtimeDirectoryName,
    installerRuntimeIdentity("review_10").runtimeDirectoryName,
  );
});
