import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const firstShellAssetResourceId = 103;

export function validateInstallerShellDocument(html) {
  const doctypeCount = [...html.matchAll(/<!doctype\s+html\b/giu)].length;
  const stylesheetEntries = [...html.matchAll(/<link\b[^>]*>/giu)]
    .filter(([tag]) => /\brel=["']stylesheet["']/iu.test(tag) && /\bhref=["']\.\/assets\/shell\.css["']/iu.test(tag));
  const scriptEntries = [...html.matchAll(/<script\b[^>]*><\/script>/giu)]
    .filter(([tag]) => /\btype=["']module["']/iu.test(tag) && /\bsrc=["']\.\/assets\/shell\.js["']/iu.test(tag));
  const externalReferences = [...html.matchAll(/\b(?:href|src)=["']([^"']+)["']/giu)]
    .map(([, reference]) => reference)
    .filter((reference) => !reference.startsWith("./assets/"));
  if (doctypeCount !== 1 || stylesheetEntries.length !== 1 || scriptEntries.length !== 1 || externalReferences.length > 0) {
    throw new Error(
      "Installer shell document must contain one HTML document, one local stylesheet, one local module entry, and no external assets.",
    );
  }
  return html;
}

export function collectInstallerShellAssets(webDirectory) {
  const assetsDirectory = path.join(webDirectory, "assets");
  if (!existsSync(assetsDirectory)) {
    throw new Error(`Installer shell assets directory is missing: ${assetsDirectory}`);
  }

  const assetFiles = [];
  const collect = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        collect(entryPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(webDirectory, entryPath).split(path.sep).join("/");
        assetFiles.push({ filePath: entryPath, relativePath });
      }
    }
  };
  collect(assetsDirectory);
  assetFiles.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);

  const requiredEntries = new Set(["assets/shell.css", "assets/shell.js"]);
  for (const asset of assetFiles) requiredEntries.delete(asset.relativePath);
  if (requiredEntries.size > 0) {
    throw new Error(`Installer shell build is missing required assets: ${[...requiredEntries].join(", ")}`);
  }

  return assetFiles.map((asset, index) => ({ ...asset, resourceId: firstShellAssetResourceId + index }));
}

export function renderEmbeddedShellAssetsHeader(assets) {
  const entries = assets
    .map((asset) => `  EmbeddedShellAsset{${asset.resourceId}, L"${asset.relativePath.replaceAll('"', '\\"')}"},`)
    .join("\r\n");
  return [
    "#pragma once",
    "#include <array>",
    "#include <string_view>",
    "",
    "struct EmbeddedShellAsset {",
    "  int resourceId;",
    "  std::wstring_view relativePath;",
    "};",
    "",
    `inline constexpr std::array<EmbeddedShellAsset, ${assets.length}> kEmbeddedShellAssets{{`,
    entries,
    "}};",
    "",
  ].join("\r\n");
}

export function resolveBackendArtifact(releaseDirectory, productVersion) {
  const expected = `Synech-Setup-${productVersion}-x64.exe`;
  const candidate = path.join(releaseDirectory, expected);
  if (!existsSync(candidate)) {
    throw new Error(`Missing NSIS backend: ${candidate}. Run pnpm dist:desktop:win:backend first.`);
  }
  return candidate;
}

export function resolveInstallMetadata(releaseDirectory) {
  const metadataPath = path.join(releaseDirectory, "installer-metadata.json");
  if (!existsSync(metadataPath)) {
    throw new Error(`Missing installer metadata: ${metadataPath}. Run pnpm dist:desktop:win:backend first.`);
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (!Number.isSafeInteger(metadata.requiredBytes) || metadata.requiredBytes <= 0) {
    throw new Error("Installer metadata requiredBytes must be a positive safe integer.");
  }
  return metadata;
}

export function outerInstallerArtifactName(productVersion, suffix = "") {
  const normalized = normalizeInstallerSuffix(suffix);
  return `Synech-Installer-${productVersion}-x64${normalized === "" ? "" : `-${normalized}`}.exe`;
}

export function demoInstallerArtifactName(suffix = "") {
  const normalized = normalizeInstallerSuffix(suffix);
  return `Synech-Installer-Demo${normalized === "" ? "" : `-${normalized}`}.exe`;
}

export function installerRuntimeIdentity(suffix = "") {
  const normalized = normalizeInstallerSuffix(suffix);
  const runtimeDirectoryName = normalized === ""
    ? "SynechInstaller"
    : `SynechInstaller_${normalized}`;
  if (normalized === "") {
    return {
      mutexName: "Local\\Synech.InstallerShell",
      windowClass: "SynechInstallerShell",
      runtimeDirectoryName,
    };
  }
  return {
    mutexName: `Local\\Synech.InstallerShell.${normalized}`,
    windowClass: `SynechInstallerShell_${normalized.replaceAll(/[^A-Za-z0-9_]/gu, "_")}`,
    runtimeDirectoryName,
  };
}

function normalizeInstallerSuffix(suffix) {
  const normalized = suffix.trim();
  if (normalized !== "" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(normalized)) {
    throw new Error("Installer artifact suffix may contain only letters, numbers, dots, underscores, and hyphens.");
  }
  return normalized;
}

function findMsBuild() {
  const configured = process.env.SYNECH_MSBUILD_PATH ?? process.env.MSBUILD_PATH;
  if (configured && existsSync(configured)) return configured;
  const knownPaths = [
    "D:\\VS\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe",
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe",
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe",
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe",
  ];
  const discovered = knownPaths.find(existsSync);
  if (discovered) return discovered;
  throw new Error("MSBuild with the C++ workload was not found. Set SYNECH_MSBUILD_PATH.");
}

function findWindowsSdk() {
  const configured = process.env.SYNECH_WINDOWS_SDK_DIR;
  const roots = [configured, "D:\\Windows Kits\\10", "C:\\Program Files (x86)\\Windows Kits\\10"].filter(Boolean);
  for (const root of roots) {
    const includeRoot = path.join(root, "Include");
    if (!existsSync(includeRoot)) continue;
    const versions = readdirSync(includeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^10\.0\.\d+\.0$/u.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    const version = versions.at(-1);
    if (version) return { root, version };
  }
  throw new Error("Windows 10/11 SDK was not found. Set SYNECH_WINDOWS_SDK_DIR.");
}

function resourcePath(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function removeStaleReleaseArtifacts(releaseDirectory, keepName) {
  mkdirSync(releaseDirectory, { recursive: true });
  const generatedArtifact = /^(?:Synech-(?:Installer|Setup)-.*\.exe(?:\.blockmap)?|latest\.yml|installer-metadata\.json)$/u;
  for (const entry of readdirSync(releaseDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === keepName || !generatedArtifact.test(entry.name)) continue;
    rmSync(path.join(releaseDirectory, entry.name), { force: true });
  }
}

function readWebView2SdkVersion(projectFile) {
  const source = readFileSync(projectFile, "utf8");
  const match = source.match(/<PackageReference\s+Include=["']Microsoft\.Web\.WebView2["']\s+Version=["']([^"']+)["']/u);
  if (match?.[1] === undefined) {
    throw new Error(`Microsoft.Web.WebView2 package version is missing from ${projectFile}.`);
  }
  return match[1];
}

function resolveNugetPackagesDirectory() {
  const configured = process.env.NUGET_PACKAGES?.trim();
  if (configured) return path.resolve(configured);
  return path.join(process.env.USERPROFILE ?? os.homedir(), ".nuget", "packages");
}

function run() {
  if (process.platform !== "win32") throw new Error("The Synech installer shell can only be built on Windows.");
  const demoBuild = process.env.SYNECH_INSTALLER_DEMO === "1";
  const packageJson = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const shellDirectory = path.join(projectRoot, "packaging", "windows", "installer-shell");
  const generatedDirectory = path.join(shellDirectory, "generated");
  const webDirectory = path.join(generatedDirectory, "web");
  const releaseDirectory = path.join(projectRoot, "release");
  const backendDirectory = path.join(releaseDirectory, "installer-backend");
  const artifactSuffix = process.env.SYNECH_INSTALLER_ARTIFACT_SUFFIX;
  const runtimeIdentity = installerRuntimeIdentity(artifactSuffix);
  // Demo only exercises the native shell's safe mock flow. It does not need a
  // real NSIS payload, which keeps review builds independent and much smaller.
  const backend = demoBuild ? undefined : resolveBackendArtifact(backendDirectory, packageJson.version);
  const installMetadata = demoBuild
    ? { requiredBytes: 1 }
    : resolveInstallMetadata(backendDirectory);

  execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm build:installer-shell:web"], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  const htmlPath = path.join(webDirectory, "index.html");
  validateInstallerShellDocument(readFileSync(htmlPath, "utf8"));
  const shellAssets = collectInstallerShellAssets(webDirectory);
  writeFileSync(
    path.join(generatedDirectory, "installer-shell-assets.h"),
    renderEmbeddedShellAssetsHeader(shellAssets),
  );
  writeFileSync(path.join(generatedDirectory, "installer-shell.rc"), [
    '#include "../src/resource.h"',
    `IDR_SYNECH_SHELL_HTML RCDATA "${resourcePath(htmlPath)}"`,
    ...shellAssets.map((asset) => `${asset.resourceId} RCDATA "${resourcePath(asset.filePath)}"`),
    ...(backend === undefined ? [] : [`IDR_SYNECH_BACKEND_INSTALLER RCDATA "${resourcePath(backend)}"`]),
    `1 ICON "${resourcePath(path.join(projectRoot, "build", "icons", "favicon.ico"))}"`,
    "",
  ].join("\r\n"));
  writeFileSync(path.join(generatedDirectory, "install-metadata.h"), [
    "#pragma once",
    "#include <cstdint>",
    `constexpr std::uint64_t kRequiredInstallBytes = ${installMetadata.requiredBytes}ULL;`,
    `constexpr bool kInstallerDemoBuild = ${demoBuild ? "true" : "false"};`,
    `constexpr wchar_t kInstallerRuntimeDirectoryName[] = L"${resourcePath(runtimeIdentity.runtimeDirectoryName)}";`,
    `constexpr wchar_t kInstallerInstanceMutex[] = L"${resourcePath(runtimeIdentity.mutexName)}";`,
    `constexpr wchar_t kInstallerWindowClass[] = L"${resourcePath(runtimeIdentity.windowClass)}";`,
    "",
  ].join("\r\n"));

  const temporaryRoot = path.resolve(os.tmpdir());
  const nativeBuildRoot = mkdtempSync(path.join(temporaryRoot, "synech-installer-shell-"));
  try {
    const nativeOutput = path.join(nativeBuildRoot, "native");
    const intermediateOutput = path.join(nativeBuildRoot, "obj");
    const windowsSdk = findWindowsSdk();
    execFileSync("dotnet", ["restore", path.join(shellDirectory, "webview2-sdk.csproj")], {
      cwd: shellDirectory,
      stdio: "inherit",
    });
    const webView2SdkRoot = path.join(
      resolveNugetPackagesDirectory(),
      "microsoft.web.webview2",
      readWebView2SdkVersion(path.join(shellDirectory, "webview2-sdk.csproj")),
    );
    if (!existsSync(path.join(webView2SdkRoot, "build", "native", "Microsoft.Web.WebView2.targets"))) {
      throw new Error("WebView2 SDK restore completed without the native build targets.");
    }
    mkdirSync(nativeOutput, { recursive: true });
    mkdirSync(intermediateOutput, { recursive: true });
    execFileSync(findMsBuild(), [
      path.join(shellDirectory, "installer-shell.vcxproj"),
      "/m",
      "/p:Configuration=Release",
      "/p:Platform=x64",
      `/p:OutDir=${nativeOutput}\\`,
      `/p:IntDir=${intermediateOutput}\\`,
      `/p:MSBuildProjectExtensionsPath=${intermediateOutput}\\`,
      `/p:WindowsSdkDir=${windowsSdk.root}\\`,
      `/p:UniversalCRTSdkDir=${windowsSdk.root}\\`,
      `/p:WindowsTargetPlatformVersion=${windowsSdk.version}`,
      `/p:WindowsSDKVersion=${windowsSdk.version}\\`,
      `/p:WebView2SdkRoot=${webView2SdkRoot}`,
    ], { cwd: shellDirectory, stdio: "inherit" });

    const source = path.join(nativeOutput, "installer-shell.exe");
    const destination = demoBuild
      ? path.join(releaseDirectory, demoInstallerArtifactName(artifactSuffix))
      : path.join(releaseDirectory, outerInstallerArtifactName(packageJson.version, artifactSuffix));
    removeStaleReleaseArtifacts(releaseDirectory, path.basename(destination));
    if (backend !== undefined) {
      copyFileSync(backend, path.join(releaseDirectory, path.basename(backend)));
      const backendBlockMap = `${backend}.blockmap`;
      if (existsSync(backendBlockMap)) copyFileSync(backendBlockMap, path.join(releaseDirectory, path.basename(backendBlockMap)));
      const updateMetadata = path.join(backendDirectory, "latest.yml");
      if (existsSync(updateMetadata)) copyFileSync(updateMetadata, path.join(releaseDirectory, "latest.yml"));
    }
    copyFileSync(source, destination);
    signOuterInstaller(destination);
    const megabytes = (readFileSync(destination).byteLength / 1024 / 1024).toFixed(1);
    console.log(`Branded installer: ${destination} (${megabytes} MiB)`);
  } finally {
    const resolvedBuildRoot = path.resolve(nativeBuildRoot);
    if (resolvedBuildRoot.startsWith(`${temporaryRoot}${path.sep}`)) {
      rmSync(resolvedBuildRoot, { recursive: true, force: true });
    }
  }
}

function signOuterInstaller(artifact) {
  const signTool = process.env.SYNECH_SIGNTOOL_PATH;
  const certificateSha1 = process.env.SYNECH_SIGN_CERT_SHA1;
  if (!signTool || !certificateSha1) {
    console.warn("Outer installer is unsigned. Configure SYNECH_SIGNTOOL_PATH and SYNECH_SIGN_CERT_SHA1 for release builds.");
    return;
  }
  const args = ["sign", "/sha1", certificateSha1, "/fd", "SHA256"];
  const timestamp = process.env.SYNECH_SIGN_TIMESTAMP_URL;
  if (timestamp) args.push("/tr", timestamp, "/td", "SHA256");
  args.push(artifact);
  execFileSync(signTool, args, { stdio: "inherit" });
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) run();
