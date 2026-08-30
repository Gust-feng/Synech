import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Historical filename retained for review continuity; these assertions now
// verify the absence of the withdrawn handoff protocol.
const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");

test("native launch submits a normal first-launch request and does not own app startup", () => {
  const launchStart = nativeSource.indexOf("bool LaunchVerifiedApplication");
  const launchEnd = nativeSource.indexOf("std::optional<DWORD> RunInstallerProcess", launchStart);
  const launchBlock = nativeSource.slice(launchStart, launchEnd);
  assert.match(launchBlock, /CreateProcessW/u);
  assert.match(launchBlock, /--first-launch-after-install/u);
  assert.match(launchBlock, /CloseHandle\(process\.hProcess\)/u);
  assert.doesNotMatch(launchBlock, /CreateNamedPipe|install-handoff|Handoff/u);
});

test("native completion action closes the installer only after launch submission", () => {
  const openStart = nativeSource.indexOf('if (type == L"app.open")');
  const openEnd = nativeSource.indexOf('if (type == L"directory.browse")', openStart);
  const openBlock = nativeSource.slice(openStart, openEnd);
  assert.match(openBlock, /if \(LaunchVerifiedApplication\(\)\)[\s\S]*DestroyWindow\(window_\)/u);
  assert.doesNotMatch(openBlock, /Handoff|handoff|WaitFor/u);
});

test("native installer has no cross-process handoff protocol", () => {
  assert.doesNotMatch(nativeSource, /CreateNamedPipeW|HandoffReadStatus|shell-commit|install-handoff/u);
});
