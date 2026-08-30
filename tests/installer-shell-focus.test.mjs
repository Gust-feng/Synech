import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
const webSource = readFileSync("packaging/windows/installer-shell/web/src/main.tsx", "utf8");

test("native installer waits for the mounted web shell before focusing it", () => {
  const navigationIndex = nativeSource.indexOf("add_NavigationCompleted");
  const readyCommandIndex = nativeSource.indexOf('type == L"shell.ready"');
  assert.ok(navigationIndex >= 0);
  assert.ok(readyCommandIndex > navigationIndex);
  assert.match(nativeSource, /SetFocus\(window_\);/u);
  assert.match(nativeSource, /if \(webShellReady_\) \{\s*CompleteWebReady\(\)/u);
  assert.match(nativeSource, /if \(navigationCompleted_\) CompleteWebReady\(\)/u);
  assert.match(nativeSource, /if \(hostReadySent_ \|\| fallbackStarted_\) return;/u);
  assert.match(nativeSource, /PostInstallLocation\(L"host\.ready"/u);
  assert.match(webSource, /postHostCommand\(\{ type: "shell\.ready" \}\)/u);
  assert.match(nativeSource, /constexpr UINT kWebReadyTimeoutMs = 5'000/u);
  assert.match(nativeSource, /StartWebView\(\)[\s\S]*?SetTimer\(window_, kWebReadyTimerId, kWebReadyTimeoutMs, nullptr\)/u);
});

test("native shell closes every WebView2 startup failure path", () => {
  assert.match(nativeSource, /const HRESULT environmentStart = CreateCoreWebView2EnvironmentWithOptions/u);
  assert.match(nativeSource, /if \(FAILED\(environmentStart\)\) StartNativeFallback\(\)/u);
  assert.match(nativeSource, /const HRESULT controllerStart = environment->CreateCoreWebView2Controller/u);
  assert.match(nativeSource, /if \(FAILED\(controllerStart\)\) StartNativeFallback\(\)/u);
  assert.match(nativeSource, /if \(FAILED\(controller_->get_CoreWebView2\(&webview_\)\) \|\| webview_ == nullptr\)/u);
  assert.match(nativeSource, /if \(!ResizeWebView\(\) \|\| !ConfigureWebView\(\)\)/u);
  assert.match(nativeSource, /const HRESULT messageRegistration = webview_->add_WebMessageReceived/u);
  assert.match(nativeSource, /const HRESULT navigationRegistration = webview_->add_NavigationCompleted/u);
  assert.match(nativeSource, /if \(hostReadySent_ \|\| fallbackStarted_\) return;/u);
});

test("installer navigates the extracted shell through a local virtual host", () => {
  assert.match(nativeSource, /WriteShellDocument\(instance_\)/u);
  assert.match(nativeSource, /ICoreWebView2_3/u);
  assert.match(nativeSource, /SetVirtualHostNameToFolderMapping/u);
  assert.match(nativeSource, /COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS/u);
  assert.match(nativeSource, /webview_->Navigate\(kShellDocumentUri\)/u);
  assert.doesNotMatch(nativeSource, /FileUri/u);
  assert.doesNotMatch(nativeSource, /NavigateToString/u);
});

test("installer focuses Continue after host.ready and keeps keyboard controls reachable", () => {
  assert.match(webSource, /useRef<HTMLButtonElement>\(null\)/u);
  assert.match(webSource, /setFocusContinueOnReady\(true\)/u);
  assert.match(webSource, /continueButtonRef\.current\?\.focus\(\)/u);
  assert.match(webSource, /className="path-change"/u);
  assert.match(webSource, /className="install-action"/u);
  assert.match(webSource, /className="window-close"/u);
  assert.ok(webSource.indexOf('className="path-change"') < webSource.indexOf('className="install-action"'));
});

test("a duplicate installer launch only focuses an already-ready visible window", () => {
  assert.match(nativeSource, /CreateMutexW\(nullptr, TRUE, kInstallerInstanceMutex\)/u);
  assert.match(nativeSource, /FindWindowW\(kInstallerWindowClass, kWindowTitle\)/u);
  assert.match(nativeSource, /existing != nullptr && IsWindowVisible\(existing\)/u);
  assert.match(nativeSource, /SetForegroundWindow\(existing\)/u);
});

test("a duplicate launch never reveals the hidden pre-ready window", () => {
  const duplicateStart = nativeSource.indexOf("if (GetLastError() == ERROR_ALREADY_EXISTS)");
  const startupStart = nativeSource.indexOf("winrt::init_apartment", duplicateStart);
  assert.ok(duplicateStart >= 0);
  assert.ok(startupStart > duplicateStart);

  const duplicateBranch = nativeSource.slice(duplicateStart, startupStart);
  const guardStart = duplicateBranch.indexOf("if (const HWND existing = FindWindowW");
  const guardEnd = duplicateBranch.indexOf("\n    }", guardStart);
  assert.ok(guardStart >= 0);
  assert.ok(guardEnd > guardStart);

  const existingWindowGuard = duplicateBranch.slice(guardStart, guardEnd);
  const visibleCheck = existingWindowGuard.indexOf("IsWindowVisible(existing)");
  const restoreCall = existingWindowGuard.indexOf("ShowWindow(existing, IsIconic(existing) ? SW_RESTORE : SW_SHOW)");
  assert.ok(visibleCheck >= 0);
  assert.ok(restoreCall > visibleCheck);
  assert.match(existingWindowGuard, /SetForegroundWindow\(existing\)/u);

  // The duplicate path may restore an already-visible/minimized window, but it
  // must never show the first instance itself before its ready handshake.
  assert.doesNotMatch(duplicateBranch, /ShowWindow\(window_,\s*SW_SHOW\)/u);
  assert.equal([...duplicateBranch.matchAll(/ShowWindow\(existing,/gu)].length, 1);

  const readyStart = nativeSource.indexOf("void CompleteWebReady()");
  const commandStart = nativeSource.indexOf("void HandleCommand", readyStart);
  assert.ok(readyStart >= 0);
  assert.ok(commandStart > readyStart);
  const readyPath = nativeSource.slice(readyStart, commandStart);
  assert.match(readyPath, /if \(hostReadySent_ \|\| fallbackStarted_\) return;[\s\S]*?put_IsVisible\(TRUE\)[\s\S]*?ShowWindow\(window_, SW_SHOW\)/u);
});
