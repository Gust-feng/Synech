import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
const hostSource = readFileSync("packaging/windows/installer-shell/web/src/host.ts", "utf8");
const webSource = readFileSync("packaging/windows/installer-shell/web/src/main.tsx", "utf8");
const mockSource = readFileSync("packaging/windows/installer-shell/web/mock.html", "utf8");

test("installer location contract separates the selected parent from the final target", () => {
  assert.match(hostSource, /readonly installParentPath: string/u);
  assert.match(nativeSource, /InstallTargetFor\(const std::filesystem::path& parent\)/u);
  assert.match(nativeSource, /return parent \/ kInstallDirectoryName;/u);
  assert.match(nativeSource, /GetNamedString\(L"installParentPath"\)/u);
  assert.match(webSource, /payload: \{ installParentPath: location\.installParentPath/u);
  assert.doesNotMatch(webSource, /payload: \{ installPath: location\.installPath/u);
  assert.match(mockSource, /const installPath = installParentPath \+ "\\\\Synech"/u);
  assert.match(nativeSource, /SetNamedValue\(L"installParentPath"/u);
  assert.match(nativeSource, /if \(type == L"directory\.browse"\) \{\s*if \(!IsInstalling\(\)\) BrowseDirectory\(\)/u);
  assert.match(webSource, /disabled=\{isBusy \|\| location\.installParentPath\.length === 0\}/u);
});

test("installer location policy accepts a drive root as the parent and rejects unsafe targets", () => {
  assert.match(nativeSource, /NormalizeAbsolutePath\(requestedParent\)/u);
  assert.doesNotMatch(nativeSource, /path\.root_path\(\) == path/u);
  assert.match(nativeSource, /install_parent_reparse/u);
  assert.match(nativeSource, /install_target_reparse/u);
  assert.match(nativeSource, /install_target_is_file/u);
  assert.match(nativeSource, /install_target_not_empty/u);
  assert.match(nativeSource, /IsDirectoryEmpty\(target\)/u);
  assert.match(nativeSource, /RegisteredUninstallInfo\(target\)/u);
});

test("installer location policy uses component-aware Product Home overlap checks", () => {
  assert.match(nativeSource, /ProductHomeCandidates\(\)/u);
  assert.match(nativeSource, /PathsOverlap\(target, productHome\)/u);
  assert.match(nativeSource, /EnvironmentValue\(L"SYNECH_HOME"\)/u);
  assert.match(nativeSource, /FOLDERID_LocalAppData/u);
  assert.match(nativeSource, /install_target_product_home_conflict/u);
  assert.match(nativeSource, /PathComponents\(/u);
  assert.match(nativeSource, /IsPathPrefix\(/u);
});

test("installer revalidates the native target and retains only an exact same-session retry target", () => {
  assert.match(nativeSource, /retryInstallTarget_/u);
  assert.match(nativeSource, /ValidateInstallLocation\(parent, RetryInstallTarget\(\)\)/u);
  assert.match(nativeSource, /sessionRetryTarget = RetryInstallTarget\(\)/u);
  assert.match(nativeSource, /ValidateInstallLocation\(location\.parent, sessionRetryTarget\)/u);
  assert.match(nativeSource, /RememberRetryInstallTarget\(installPath\)/u);
  assert.match(nativeSource, /ClearRetryInstallTarget\(\)/u);
  assert.match(nativeSource, /retryTarget\.has_value\(\) && !PathsEqual\(retryTarget\.value\(\), validation\.location->target\)/u);
  assert.match(nativeSource, /PathsEqual\(target, sessionAcceptedTarget\.value\(\)\)/u);
  assert.match(nativeSource, /const std::wstring backendArgs = L"\/S \/D=" \+ installPath\.native\(\)/u);
  assert.doesNotMatch(nativeSource, /backendArgs.*QuoteArgument/u);
});

test("path-policy failures promote choosing another parent directory", () => {
  const stateSource = readFileSync("packaging/windows/installer-shell/web/src/install-state.ts", "utf8");
  for (const code of [
    "invalid_install_parent",
    "install_parent_reparse",
    "install_target_reparse",
    "install_target_is_file",
    "install_target_not_empty",
    "install_target_unavailable",
    "install_target_product_home_conflict",
  ]) {
    assert.match(stateSource, new RegExp(code, "u"));
  }
  assert.match(stateSource, /primary: "change-location"/u);
});
