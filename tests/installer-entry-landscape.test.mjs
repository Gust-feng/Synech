import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const installerEntry = readFileSync("packaging/windows/installer-shell/web/src/main.tsx", "utf8");
const installerStyles = readFileSync("packaging/windows/installer-shell/web/src/styles.css", "utf8");
const nativeShell = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");

test("installer uses the supplied illustration as a dedicated left panel", () => {
  assert.match(installerEntry, /assets\/installer-artwork\.png/u);
  assert.match(installerEntry, /<aside className="artwork-panel"/u);
  assert.match(installerEntry, /<img src=\{installerArtwork\} alt=""/u);
  assert.match(installerStyles, /grid-template-columns: minmax\(270px, 38%\)/u);
  assert.match(installerStyles, /object-fit: cover/u);
  assert.doesNotMatch(installerEntry, /EntryLandscape/u);
});

test("installer window provides room for the split layout", () => {
  assert.match(nativeShell, /constexpr int kWindowWidth = 820;/u);
  assert.match(nativeShell, /constexpr int kWindowHeight = 540;/u);
});

test("installer exposes app launch as an explicit completion action", () => {
  assert.match(nativeShell, /if \(type == L"app\.open"\)/u);
  assert.match(nativeShell, /LaunchVerifiedApplication\(\)/u);
  assert.doesNotMatch(nativeShell, /PostPhase\(L"completed"\);\s*LaunchVerifiedApplication/u);
  assert.match(nativeShell, /L" --first-launch-after-install"/u);
  assert.doesNotMatch(nativeShell, /CreateNamedPipeW|install-handoff|HandoffReadStatus/u);
});

test("installer keeps the location screen focused on the actionable controls", () => {
  assert.doesNotMatch(installerEntry, /选择上级目录|父目录中的其他文件不会受影响/u);
  assert.match(installerEntry, /className="path-field"/u);
  assert.match(installerEntry, /className="path-change"/u);
});
