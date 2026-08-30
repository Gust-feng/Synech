import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const sourcePath = "packaging/windows/installer-shell/web/src/install-state.ts";
const compiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const state = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);

const activitySource = readFileSync("packaging/windows/installer-shell/web/src/install-activity-state.ts", "utf8")
  .replace(/^import type[\s\S]*?from "\.\/host";\s*/u, "");
const activityCompiled = ts.transpileModule(activitySource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const activity = await import(`data:text/javascript,${encodeURIComponent(activityCompiled)}`);

test("backend failure keeps retry as the primary action", () => {
  assert.deepEqual(state.failureAction("backend_failed"), {
    primary: "retry",
    retryLabel: "重新安装",
    changeLocationLabel: "更改安装位置",
  });
});

test("invalid install path promotes location change to the primary action", () => {
  assert.deepEqual(state.failureAction("invalid_install_path"), {
    primary: "change-location",
    retryLabel: "重新安装",
    changeLocationLabel: "选择安装位置",
  });
});

test("unknown failure falls back to retry as the primary action", () => {
  assert.deepEqual(state.failureAction("unknown_failure"), {
    primary: "retry",
    retryLabel: "重新安装",
    changeLocationLabel: "更改安装位置",
  });
});

test("browser installer preview completes directly after shortcut projection", () => {
  const mockSource = readFileSync("packaging/windows/installer-shell/web/mock.html", "utf8");
  const shortcutCompletion = mockSource.indexOf('activity("sync-shortcuts", "shortcuts", "completed"');
  const completedPhase = mockSource.indexOf('phase("completed")', shortcutCompletion);
  assert.ok(shortcutCompletion >= 0);
  assert.ok(completedPhase > shortcutCompletion);
  assert.doesNotMatch(mockSource, /prepare-launch|phase\("launching"\)/u);
});

test("installer preview injects its host without overwriting browser chrome", () => {
  const hostSource = readFileSync("packaging/windows/installer-shell/web/src/host.ts", "utf8");
  const mockSource = readFileSync("packaging/windows/installer-shell/web/mock.html", "utf8");
  assert.match(hostSource, /__synechInstallerMockWebview/u);
  assert.match(hostSource, /window\.chrome\?\.webview \?\? window\.__synechInstallerMockWebview/u);
  assert.match(mockSource, /window\.__synechInstallerMockWebview =/u);
  assert.doesNotMatch(mockSource, /window\.chrome\s*=/u);
});

test("installer preview auto-plays after Continue unless manual mode is requested", () => {
  const mockSource = readFileSync("packaging/windows/installer-shell/web/mock.html", "utf8");
  assert.match(mockSource, /manualPlayback/u);
  assert.match(mockSource, /if \(!manualPlayback\) setTimeout\(playAuto, 250\)/u);
  assert.match(mockSource, /get\("manual"\) === "1"/u);
});

test("native installer demo is a build-time safe mock flow that cannot fall back to installation", () => {
  const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
  const shellBuild = readFileSync("scripts/build-windows-installer-shell.mjs", "utf8");
  const demoBuild = readFileSync("scripts/build-windows-installer-demo.mjs", "utf8");
  assert.match(nativeSource, /kDemoInstallPath\[\] = L"C:\\\\Demo\\\\Synech"/u);
  assert.match(nativeSource, /kInstallerRuntimeDirectoryName/u);
  assert.match(nativeSource, /kInstallerRuntimeOwnerMarker/u);
  assert.match(nativeSource, /g_installerRuntimeDirectory/u);
  assert.match(nativeSource, /is_regular_file\(entry\.path\(\) \/ kInstallerRuntimeOwnerMarker/u);
  assert.match(nativeSource, /remove_all\(g_installerRuntimeDirectory/u);
  assert.match(nativeSource, /RemoveLegacyInstallerRuntimeDirectories\(base\)/u);
  assert.match(nativeSource, /shellDirectory = WriteShellDocument\(instance_\)\.parent_path\(\);/u);
  assert.doesNotMatch(nativeSource, /kInstallerDemoUrl|127\.0\.0\.1:5199\/mock\.html/u);
  assert.match(nativeSource, /if \(demo_\) \{\s*HandleDemoCommand\(command, type\);\s*return;/u);
  assert.match(nativeSource, /void HandleDemoCommand[\s\S]*?StartDemoInstall/u);
  const demoHandler = nativeSource.slice(nativeSource.indexOf("void HandleDemoCommand"), nativeSource.indexOf("void BrowseDirectory"));
  assert.match(demoHandler, /type == L"app\.open"[\s\S]*?DestroyWindow\(window_\)/u);
  assert.doesNotMatch(demoHandler, /LaunchVerifiedApplication/u);
  assert.match(nativeSource, /void StartDemoInstall[\s\S]*?PostArtifacts[\s\S]*?PostPhase\(L"completed"\);/u);
  // The UI thread releases the demo close guard when it consumes the terminal
  // phase. The worker itself never clears the guard after posting to HWND.
  assert.match(nativeSource, /event->value == L"completed"[\s\S]*?demoPlaybackRunning_\.store\(false\)/u);
  assert.doesNotMatch(nativeSource.slice(nativeSource.indexOf("void StartDemoInstall")), /demoPlaybackRunning_\.store\(false\)/u);
  assert.doesNotMatch(nativeSource, /PostExitAfterCompletion|autoLaunch|LaunchProcess/u);
  assert.match(nativeSource, /void PostDemoLocation[\s\S]*?kDemoInstallBytes[\s\S]*?kDemoAvailableBytes/u);
  assert.match(nativeSource, /const bool demo = kInstallerDemoBuild;/u);
  assert.doesNotMatch(nativeSource, /std::wstring_view\(commandLine\).*--demo/u);
  assert.match(nativeSource, /void StartInstall[\s\S]*?if \(demo_\) return;/u);
  assert.match(nativeSource, /std::optional<DWORD> RunInstallerProcess[\s\S]*?if \(demo_\) return std::nullopt;/u);
  assert.match(nativeSource, /void StartNativeFallback\(\)[\s\S]*?if \(demo_\) \{[\s\S]*?不会回退到正式安装流程[\s\S]*?PostEvent\(UiEventKind::Exit/u);
  assert.match(shellBuild, /const demoBuild = process\.env\.SYNECH_INSTALLER_DEMO === "1"/u);
  assert.match(shellBuild, /kInstallerDemoBuild = \$\{demoBuild \? "true" : "false"\}/u);
  assert.match(demoBuild, /SYNECH_INSTALLER_DEMO: "1"/u);
  const hostSource = readFileSync("packaging/windows/installer-shell/web/src/host.ts", "utf8");
  assert.match(hostSource, /isNativeDemo/u);
});

test("production WebView2 failure does not bypass the parent-directory policy", () => {
  const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
  const fallbackStart = nativeSource.indexOf("void StartNativeFallback");
  const postWebMessageStart = nativeSource.indexOf("void PostWebMessage", fallbackStart);
  assert.ok(fallbackStart >= 0 && postWebMessageStart > fallbackStart);
  const fallback = nativeSource.slice(fallbackStart, postWebMessageStart);
  const productionBranch = fallback.slice(fallback.indexOf("if (demo_)"));
  assert.match(productionBranch, /缺少 Microsoft Edge WebView2 Runtime/u);
  assert.match(productionBranch, /PostEvent\(UiEventKind::Exit/u);
  assert.doesNotMatch(productionBranch, /ExtractedBackend|RunProcess|StartWorker/u);
});

test("activity projection keeps one current and one recent structured record", () => {
  const prepare = {
    id: "prepare-installer",
    kind: "package",
    state: "started",
    objects: [{ kind: "package", path: "Synech-Setup.exe" }],
  };
  const files = {
    id: "install-application",
    kind: "files",
    state: "started",
    objects: [{ kind: "directory", path: "C:\\\\Programs\\\\Synech" }],
  };
  const first = activity.reduceInstallActivity(activity.createInstallActivityState(), prepare);
  const second = activity.reduceInstallActivity(first, files);
  assert.equal(second.current.id, "install-application");
  assert.equal(second.recent.id, "prepare-installer");
  assert.equal(second.current.objects[0].kind, "directory");

  const completed = { ...files, state: "completed", objects: [{ kind: "directory", path: "C:\\\\Programs\\\\Synech" }] };
  const third = activity.reduceInstallActivity(second, completed);
  assert.equal(third.current.state, "completed");
  assert.equal(third.recent.id, "prepare-installer");
});

test("native install progress comes only from bytes observed on disk", () => {
  const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
  const workflow = nativeSource.slice(
    nativeSource.indexOf("void StartInstall"),
    nativeSource.indexOf("std::optional<DWORD> RunInstallerProcess"),
  );
  assert.doesNotMatch(workflow, /Sleep\s*\(/u);
  const runner = nativeSource.slice(
    nativeSource.indexOf("std::optional<DWORD> RunInstallerProcess"),
    nativeSource.indexOf("void StartNativeFallback"),
  );
  assert.match(runner, /CaptureInstallFiles\(installPath\)/u);
  assert.match(runner, /ChangedInstallFiles\(previousSnapshot, current\)/u);
  assert.match(runner, /WrittenBytesSince\(baseline, current\)/u);
  assert.match(runner, /std::to_wstring\(kRequiredInstallBytes\)/u);
  assert.match(runner, /PostActivityProgress\(L"install-application"/u);
  // 字节数没有变化时不发任何进度事件：安静也是真实状态的一部分
  assert.match(runner, /writtenBytes != reportedBytes/u);
  assert.match(nativeSource, /constexpr DWORD kInstallObservationIntervalMs = 300/u);
  assert.match(runner, /WaitForSingleObject\(process\.hProcess, kInstallObservationIntervalMs\)/u);
});

test("application verification is driven by a named required-file set", () => {
  const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
  assert.match(nativeSource, /RequiredApplicationFiles\(\)/u);
  assert.match(nativeSource, /RequiredApplicationFilesPresent\(installPath\)/u);
  assert.doesNotMatch(nativeSource, /applicationObjects\.size\(\)\s*!==\s*3/u);
});

test("native shell no longer carries simulated chunk projection", () => {
  const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
  assert.doesNotMatch(nativeSource, /BuildInstallChunks|kInstallChunkBytes|pacingConstant|streamedChunks|streamedBytes/u);
  assert.doesNotMatch(nativeSource, /IDR_SYNECH_INSTALL_FILES|LoadResourceUtf8/u);
  const resources = readFileSync("packaging/windows/installer-shell/src/resource.h", "utf8");
  assert.doesNotMatch(resources, /IDR_SYNECH_INSTALL_FILES/u);
  const shellBuild = readFileSync("scripts/build-windows-installer-shell.mjs", "utf8");
  assert.doesNotMatch(shellBuild, /resolveInstallFiles|install-files\.json/u);
  const backendBuild = readFileSync("scripts/build-windows-nsis-backend.mjs", "utf8");
  assert.doesNotMatch(backendBuild, /installer-files\.json|listInstallFiles/u);
});

test("native installer reports every changed file instead of dropping a capped tail", () => {
  const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
  const changedFiles = nativeSource.slice(
    nativeSource.indexOf("std::vector<InstallArtifact> ChangedInstallFiles"),
    nativeSource.indexOf("std::uint64_t WrittenBytesSince"),
  );
  assert.doesNotMatch(changedFiles, /kMaximumReportedFiles|changed\.size\(\).*break/u);
});

test("web progress bar uses one honest track with an indeterminate preparation mode", () => {
  const webSource = readFileSync("packaging/windows/installer-shell/web/src/main.tsx", "utf8");
  assert.match(webSource, /useSmoothedProgress/u);
  assert.match(webSource, /install-progress-fill/u);
  assert.match(webSource, /role="status"/u);
  // 平滑只作用于呈现：单调趋近真实比例，数值本身永远是真实值
  assert.match(webSource, /Math\.max\(displayRef\.current, target\)/u);
  // 首个真实比例在绘制前种入，切换出不定态时不得经过 0% 空条
  assert.match(webSource, /useLayoutEffect/u);
  assert.match(webSource, /const hasTargetRef = useRef\(false\)/u);
  assert.match(webSource, /displayRef\.current = target/u);
  assert.match(webSource, /setDisplay\(target\)/u);
  assert.match(webSource, /return display \?\? \(target === null \? null : target\)/u);
  // 首字节写入之前只切换同一条轨道的循环填充，不伪造安装百分比。
  assert.match(webSource, /indeterminate=\{phase === "preparing"/u);
  assert.match(webSource, /is-indeterminate/u);
  assert.match(webSource, /aria-busy=\{props\.indeterminate\}/u);
  assert.doesNotMatch(webSource, /安装完成后自动打开 Synech/u);
  // 不再有分段权重或模拟比例
  assert.doesNotMatch(webSource, /progressTarget|installRatio|stepIndexForActivity|extractRatio/u);
  const styles = readFileSync("packaging/windows/installer-shell/web/src/styles.css", "utf8");
  // 从准备到完成只有一个 track 和一个 fill，循环只移动 fill 本身。
  assert.match(styles, /\.install-progress-track\.is-indeterminate \.install-progress-fill/u);
  assert.match(styles, /\.install-progress-track::before/u);
  assert.match(styles, /\.install-progress-fill[\s\S]*?transition: width 420ms/u);
  assert.match(styles, /@keyframes install-progress-indeterminate/u);
  assert.match(styles, /left: -34%/u);
  assert.match(styles, /1\.35s linear infinite/u);
  assert.doesNotMatch(styles, /install-progress-sheen/u);
});

test("installer completion enters as a paced scene instead of an instant swap", () => {
  const styles = readFileSync("packaging/windows/installer-shell/web/src/styles.css", "utf8");
  const introStyles = readFileSync("src/app/panel-ui/src/shell/entry-scene/launch-intro.css", "utf8");
  assert.match(styles, /\.completion-stage\.is-visible \.completion-frame[\s\S]*?completion-frame-enter/u);
  assert.match(styles, /@keyframes completion-frame-enter/u);
  assert.match(styles, /transition: opacity 560ms/u);
  assert.match(introStyles, /transition: opacity 560ms/u);
});

test("install progress occupies its final geometry from the first rendered frame", () => {
  const styles = readFileSync("packaging/windows/installer-shell/web/src/styles.css", "utf8");
  // 配置、准备、安装阶段共享同一个内容锚点和标题高度，不能因阶段切换重新排版。
  assert.match(styles, /\.installer-surface\s*\{[\s\S]*?margin:\s*34px auto 0/u);
  assert.match(styles, /\.surface-heading\s*\{\s*min-height:\s*52px/u);
  assert.doesNotMatch(styles, /\.phase-(?:preparing|installing|completed) \.installer-surface/u);
  assert.doesNotMatch(styles, /\.phase-(?:preparing|installing|completed) \.surface-heading/u);
  // 进度容器不从偏移位置飞入，首帧和稳态必须使用同一 transform。
  const installStreamRules = styles.slice(styles.indexOf(".install-stream {"), styles.indexOf(".configure-controls {"));
  assert.doesNotMatch(installStreamRules, /transform\s*:/u);
  assert.doesNotMatch(installStreamRules, /install-stream-arrive|@keyframes/u);
});

test("write rate derives from a sliding window over real progress events", () => {
  const webSource = readFileSync("packaging/windows/installer-shell/web/src/main.tsx", "utf8");
  assert.match(webSource, /rateSamplesRef/u);
  assert.match(webSource, /now - samples\[0\]\.t > 1500/u);
  assert.match(webSource, /install-progress-data/u);
  const styles = readFileSync("packaging/windows/installer-shell/web/src/styles.css", "utf8");
  assert.match(styles, /\.install-progress-data/u);
});

test("install log presents real events as they arrive without artificial pacing", () => {
  const webSource = readFileSync("packaging/windows/installer-shell/web/src/main.tsx", "utf8");
  const styles = readFileSync("packaging/windows/installer-shell/web/src/styles.css", "utf8");
  assert.match(webSource, /useInstallLog/u);
  assert.match(webSource, /logWindowLines = 9/u);
  assert.match(webSource, /install-log/u);
  assert.match(webSource, /className="install-target-context"/u);
  assert.match(webSource, /message\.type === "install\.artifacts"/u);
  assert.match(webSource, /message\.type === "install\.activity"/u);
  // 文件行统一展示相对安装目录的路径
  assert.match(webSource, /stripInstallRoot\(file\.path, installPath\)/u);
  for (const verb of ["extract", "install", "write", "verify", "register", "shortcut"]) {
    assert.match(webSource, new RegExp(`verb: "${verb}"`, "u"));
  }
  assert.match(webSource, /key=\{`install-attempt-\$\{installAttempt\}`\}/u);
  assert.doesNotMatch(webSource, /prepare-launch/u);
  assert.match(webSource, /surfaceMode === "launching" \? " is-launching" : " is-hidden"/u);
  assert.match(styles, /install-log-line-in/u);
  // 不再有模拟进料、人为行间隔或双重计数统计
  assert.doesNotMatch(webSource, /activityLineIntervalMs|fileLineBatchSize|fileLineIntervalMs/u);
  assert.doesNotMatch(webSource, /useInstallFeed|consumeInstallFeed|reportInstallArtifacts|InstallFeedStats/u);
  assert.doesNotMatch(styles, /install-progress-stats/u);
});

test("native installer reports files observed in the real target directory", () => {
  const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
  const hostSource = readFileSync("packaging/windows/installer-shell/web/src/host.ts", "utf8");
  assert.match(nativeSource, /CaptureInstallFiles\(installPath\)/u);
  assert.match(nativeSource, /ChangedInstallFiles\(previousSnapshot, current\)/u);
  assert.match(nativeSource, /PostWebMessage\(L"install\.artifacts"/u);
  assert.match(nativeSource, /sizeBytes/u);
  assert.match(hostSource, /type: "install\.artifacts"/u);
  assert.match(hostSource, /readonly artifacts/u);
  assert.match(hostSource, /readonly key\?:/u);
});

test("completion keeps one scene entry, plays the bundled Lottie scene once over it, then waits for the user", () => {
  const webSource = readFileSync("packaging/windows/installer-shell/web/src/main.tsx", "utf8");
  const cardSource = readFileSync("packaging/windows/installer-shell/web/src/completion-card-stage.tsx", "utf8");
  const styles = readFileSync("packaging/windows/installer-shell/web/src/styles.css", "utf8");
  const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
  assert.match(webSource, /CompletionCardStage/u);
  assert.match(webSource, /visible=\{celebrationVisible\}/u);
  assert.match(webSource, /onLaunch=\{\(\) => postHostCommand\(\{ type: "app\.open" \}\)\}/u);
  assert.match(webSource, /const completionHoldMs = 600/u);
  // 场景入口随完成场景稳定存在：与彩带同属完成场景，不是彩带结束后的新对象。
  assert.match(cardSource, /"completion-stage"/u);
  assert.match(cardSource, /className="scene-entry"/u);
  assert.match(cardSource, /scene-entry__tab/u);
  assert.doesNotMatch(cardSource, /scene-entry__status/u);
  assert.doesNotMatch(styles, /\.scene-entry__status/u);
  assert.match(styles, /\.scene-entry__tab\s*\{[\s\S]*?border-top:[^;]+;[\s\S]*?border-bottom:[^;]+;/u);
  assert.match(styles, /\.scene-entry__tab::before/u);
  assert.match(styles, /\.scene-entry__tab\s*\{[\s\S]*?min-height:\s*44px/u);
  assert.match(cardSource, /scene-entry__tab-action/u);
    // 卡外是低对比、静态的色场与规划标记；景观只在唯一入口内出现。
    assert.match(cardSource, /completion-backdrop__marks/u);
    assert.match(cardSource, /completion-backdrop__contours/u);
    assert.match(cardSource, /completion-backdrop__dots/u);
    assert.match(cardSource, /className="completion-backdrop"\s+aria-hidden="true"/u);
    assert.match(cardSource, /className="completion-frame"/u);
    assert.match(styles, /\.completion-backdrop\s*\{[\s\S]*?pointer-events:\s*none/u);
    assert.match(styles, /\.completion-backdrop__marks\s*\{/u);
    assert.match(styles, /\.completion-backdrop__contours\s*\{/u);
    assert.match(styles, /--completion-paper-grain:\s*url\([^;]+feTurbulence/u);
    assert.match(styles, /\.completion-frame::before\s*\{[\s\S]*?inset:\s*var\(--completion-frame-padding\) var\(--completion-frame-padding\) var\(--completion-frame-bottom-padding\)/u);
    assert.match(styles, /\.completion-frame__grain\s*\{[\s\S]*?background-size:\s*240px 240px[\s\S]*?opacity:\s*0\.035/u);
    assert.doesNotMatch(styles, /\.scene-entry__viewport::after/u);
  assert.match(styles, /--completion-background\s*:\s*linear-gradient/u);
  assert.match(styles, /\.completion-stage\s*\{[\s\S]*?background:\s*var\(--completion-background\)/u);
  assert.match(styles, /--completion-background\s*:[\s\S]{0,300}?radial-gradient/u);
  assert.doesNotMatch(styles, /scene-entry-enter|\.completion-stage\.is-visible\s+\.scene-entry/u);
  assert.doesNotMatch(cardSource, /completion-eyebrow|completion-invitation|gift-card/u);
  assert.match(cardSource, /aria-label="打开 Synech"/u);
  // 彩带只在卡片前景播放一次，结束后进入 is-confetti-done 收场，不追加第二次爆发。
  assert.match(cardSource, /@lottiefiles\/dotlottie-web/u);
  assert.match(cardSource, /completion-confetti\.lottie/u);
  assert.match(cardSource, /loop: false/u);
  assert.match(cardSource, /addEventListener\("complete", finish\)/u);
  assert.match(cardSource, /setConfettiDone\(true\)/u);
  assert.doesNotMatch(cardSource, /goToAndPlay|restart|setSpeed|repeatCount|loop: true/u);
  assert.match(styles, /\.completion-stage\.is-confetti-done \.completion-confetti/u);
  assert.match(styles, /visibility: hidden/u);
  // 整卡是启动入口：键盘可达（button + Enter/Space 原生），点击立即提交启动命令，
  // 不在安装器本地追加展开动画。
  assert.match(cardSource, /<button/u);
  assert.match(cardSource, /props\.onLaunch\(\)/u);
  assert.doesNotMatch(cardSource, /setOpenState|PRESS_HOLD_MS|gift-card-open-scale|is-pressed|is-opening/u);
  assert.match(cardSource, /LAUNCH_RETRY_GUARD_MS/u);
  // 普通安装不会自动打开应用：onLaunch 只在点击处理器体内直接调用。
  assert.doesNotMatch(webSource, /autoLaunch|安装完成后自动打开|prepare-launch/u);
  assert.match(cardSource, /const handleOpen = \(\): void => \{[\s\S]*?props\.onLaunch\(\);/u);
  assert.doesNotMatch(cardSource, /setTimeout\([\s\S]{0,100}onLaunch/u);
  // 不再使用礼盒、封蜡、S 形磁贴、光环等装饰。
  assert.doesNotMatch(cardSource, /completion-launch-mark|completion-launch-aura|gift-box|gift-wrap|seal/u);
  assert.doesNotMatch(styles, /completion-wrapper|completion-launch-mark|completion-launch-aura/u);
  // 完成卡片保持静态：不注册指针监听、不调度逐帧视差，也不引用视差常量。
  assert.doesNotMatch(cardSource, /pointermove|pointerleave|requestAnimationFrame/u);
  assert.doesNotMatch(cardSource, /HOME_SCENE_PARALLAX_FACTORS|HOME_SCENE_CARD_MAX_POINTER_SHIFT/u);
  assert.match(cardSource, /reduceMotion/u);
  // 悬浮不改变卡片位置，也不触发 frame/tab 的局部动画。
  assert.doesNotMatch(styles, /\.scene-entry:hover[^{}]*\{[^}]*\btransform\s*:/u);
  assert.doesNotMatch(styles, /\.scene-entry:hover\s+\.scene-entry__(?:frame|tab)(?:::before)?/u);
  // 庆祝只发生在安装窗口内，不能留置顶原生浮层到桌面。
  assert.doesNotMatch(nativeSource, /Firework|ShowCompletionOverlay|WS_EX_TRANSPARENT|SPI_GETCLIENTAREAANIMATION|PostExitAfterCompletion/u);
});

test("completed install releases the native busy guard when the terminal event is consumed", () => {
  const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
  const eventHandler = nativeSource.slice(nativeSource.indexOf("void HandleUiEvent"), nativeSource.indexOf("void ConfigureWebView"));
  assert.match(eventHandler, /event->value == L"completed"[\s\S]*?installing_\.store\(false\)/u);
  const installWorker = nativeSource.slice(nativeSource.indexOf("void StartInstall"), nativeSource.indexOf("void StartDemoInstall"));
  assert.doesNotMatch(installWorker, /installing_\.store\(false\)/u);
});

test("native shell releases the complete offline Vite tree before navigation", () => {
  const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
  const shellBuild = readFileSync("scripts/build-windows-installer-shell.mjs", "utf8");
  assert.match(nativeSource, /#include "\.\.\/generated\/installer-shell-assets\.h"/u);
  assert.match(nativeSource, /void WriteEmbeddedResource/u);
  assert.match(nativeSource, /kEmbeddedShellAssets/u);
  assert.match(nativeSource, /directory \/ std::filesystem::path\(std::wstring\(asset\.relativePath\)\)/u);
  assert.match(nativeSource, /directory \/ L"index\.html"/u);
  assert.doesNotMatch(nativeSource, /directory \/ L"shell\.html"/u);
  assert.match(shellBuild, /collectInstallerShellAssets/u);
  assert.match(shellBuild, /renderEmbeddedShellAssetsHeader/u);
  assert.match(shellBuild, /RCDATA "\$\{resourcePath\(asset\.filePath\)\}"/u);
});

test("installer launches the app only from the explicit completion action", () => {
  const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
  const webSource = readFileSync("packaging/windows/installer-shell/web/src/main.tsx", "utf8");
  assert.match(nativeSource, /PostPhase\(L"completed"\)/u);
  assert.match(nativeSource, /if \(type == L"app\.open"\)[\s\S]*?LaunchVerifiedApplication\(\)/u);
  assert.match(nativeSource, /RememberVerifiedApplication\(installPath \/ L"Synech\.exe"\)/u);
  assert.doesNotMatch(nativeSource, /PostPhase\(L"completed"\);\s*LaunchVerifiedApplication/u);
  assert.match(webSource, /postHostCommand\(\{ type: "app\.open" \}\)/u);
  assert.doesNotMatch(webSource, /autoLaunch|安装完成后自动打开|prepare-launch/u);
});

test("native shell reports progress around the work it actually owns", () => {
  const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
  const preparing = nativeSource.indexOf('PostPhase(L"preparing")');
  const extraction = nativeSource.indexOf("const ExtractedBackend backend");
  const installing = nativeSource.indexOf('PostPhase(L"installing")');
  const backendRun = nativeSource.indexOf("exitCode = RunInstallerProcess");
  const applicationVerification = nativeSource.indexOf('PostActivity(L"verify-application-files",');
  const uninstallVerification = nativeSource.indexOf('PostActivity(L"verify-uninstall-info",');
  const shortcuts = nativeSource.indexOf('PostActivity(L"sync-shortcuts",');
  const completed = nativeSource.indexOf('PostPhase(L"completed")');
  assert.ok(preparing >= 0 && preparing < extraction);
  assert.ok(extraction < installing && installing < backendRun);
  assert.ok(backendRun < applicationVerification);
  assert.ok(applicationVerification < uninstallVerification);
  assert.ok(uninstallVerification < shortcuts && shortcuts < completed);
  for (const id of ["prepare-installer", "install-application", "verify-application-files", "verify-uninstall-info", "sync-shortcuts"]) {
    assert.match(nativeSource, new RegExp(`PostActivity\\(L"${id}"`, "u"));
  }
  assert.doesNotMatch(nativeSource, /PostPhase\(L"handoff"\)/u);
});

test("installer sends real disk space and shortcut preferences through the host boundary", () => {
  const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
  const webSource = readFileSync("packaging/windows/installer-shell/web/src/main.tsx", "utf8");
  assert.match(nativeSource, /GetDiskFreeSpaceExW/u);
  assert.match(nativeSource, /kRequiredInstallBytes/u);
  assert.match(nativeSource, /ApplyShortcutPreferences/u);
  assert.match(webSource, /createStartMenuShortcut/u);
  assert.match(webSource, /createDesktopShortcut/u);
});

test("installer verifies generated uninstall registration instead of assuming the app id is the key", () => {
  const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
  assert.match(nativeSource, /RegEnumKeyExW/u);
  assert.match(nativeSource, /RegQueryValueExW\(key, L"DisplayName"/u);
  assert.match(nativeSource, /RegQueryValueExW\(\s*key,\s*L"UninstallString",/u);
  assert.match(nativeSource, /UninstallerPathFromCommand/u);
  assert.match(nativeSource, /is_regular_file\(uninstaller\.value\(\)/u);
  assert.match(nativeSource, /installedName\.starts_with\(L"Synech "\)/u);
  assert.match(nativeSource, /PathsEqual\(uninstaller->parent_path\(\), installPath\)/u);
  assert.doesNotMatch(nativeSource, /Uninstall\\\\com\.synech\.app/u);
});

test("native shell starts only the verified application and then exits", () => {
  const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");
  assert.match(nativeSource, /bool LaunchVerifiedApplication\(\)/u);
  assert.match(nativeSource, /std::filesystem::is_regular_file\(application\.value\(\), error\)/u);
  assert.match(nativeSource, /L" --first-launch-after-install"/u);
  assert.match(nativeSource, /CloseHandle\(process\.hProcess\)/u);
  assert.doesNotMatch(nativeSource, /CreateNamedPipeW|install-handoff|HandoffReadStatus/u);
  assert.doesNotMatch(nativeSource, /prepare-launch|autoLaunch/u);
});
