import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const indexHtml = readFileSync("src/app/panel-ui/index.html", "utf8");
const introSource = readFileSync("src/app/panel-ui/src/shell/entry-scene/launch-intro.tsx", "utf8");
const introCss = readFileSync("src/app/panel-ui/src/shell/entry-scene/launch-intro.css", "utf8");
const stateSource = readFileSync("src/app/panel-ui/src/shell/entry-scene/launch-intro-state.ts", "utf8");
const sceneSource = readFileSync("src/app/panel-ui/src/shell/entry-scene/home-scene.ts", "utf8");
const launcherSource = readFileSync("src/app/desktop/panel-desktop-launcher.ts", "utf8");
const desktopMainSource = readFileSync("src/app/desktop/panel-desktop-main.ts", "utf8");
const homeBackdropSource = readFileSync(
  "src/app/panel-ui/src/personal-workbench/workbench/app/components/HomeBackdrop.tsx",
  "utf8",
);
const cardSource = readFileSync(
  "packaging/windows/installer-shell/web/src/completion-card-stage.tsx",
  "utf8",
);

const stateCompiled = ts.transpileModule(stateSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const state = await import(`data:text/javascript,${encodeURIComponent(stateCompiled)}`);

test("first frame never shows the structural skeleton on a first launch", () => {
  assert.match(indexHtml, /html\[data-launch='installed'\] \.workbench-bootstrap/u);
  assert.match(indexHtml, /html\[data-launch='updated'\] \.workbench-bootstrap/u);
  assert.match(indexHtml, /display: none/u);
  assert.match(introSource, /renderHomeScene/u);
  assert.match(introSource, /data-phase/u);
  assert.doesNotMatch(introSource, /workbench-bootstrap|sidebar|topbar|composer-input/u);
});
test("installer and Electron keep their launch scenes well-defined", () => {
  assert.match(homeBackdropSource, /preserveAspectRatio="xMidYMax slice"/u);
  assert.match(homeBackdropSource, /HOME_SCENE_HEIGHT = 900/u);
  assert.match(introSource, /from "\.\/home-scene"/u);
  assert.match(cardSource, /from "@synech\/scene"/u);
  assert.match(sceneSource, /HOME_SCENE_WIDTH = 1440/u);
  assert.match(sceneSource, /HOME_SCENE_HEIGHT = 960/u);
  assert.match(introSource, /preserveAspectRatio: "xMidYMid meet"/u);
  assert.match(introSource, /idPrefix: "ui-launch"/u);
  assert.match(cardSource, /idPrefix: "installer-card"/u);
});

test("launch mode travels inside Electron without installer handoff state", () => {
  assert.match(launcherSource, /panelLaunchUrl\(panelUrl, args\.desktopLaunch\)/u);
  assert.match(launcherSource, /launch=\$\{desktopLaunch\}/u);
  assert.doesNotMatch(launcherSource, /handoff/u);
  assert.match(indexHtml, /new URLSearchParams\(window\.location\.search\)\.get\("launch"\)/u);
  assert.match(indexHtml, /dataset\.launch/u);
  assert.doesNotMatch(introSource, /InstallHandoff|handoff/u);
});

test("desktop keeps the window hidden until the renderer has painted its first frame", () => {
  const loadBlock = launcherSource.slice(
    launcherSource.indexOf("window.onReadyToShow"),
    launcherSource.indexOf("  } catch (error)", launcherSource.indexOf("window.onReadyToShow")),
  );
  assert.match(loadBlock, /window\.onReadyToShow\(\(\) => \{[\s\S]*showPanelDesktopWindow\(window\);[\s\S]*await window\.loadUrl/u);
  assert.doesNotMatch(loadBlock, /await window\.loadUrl[\s\S]*showPanelDesktopWindow\(window\)/u);
  assert.doesNotMatch(desktopMainSource, /backgroundThrottling: false|InstallHandoff|handoff/u);
});

test("launch tiers pick the right phase", () => {
  assert.equal(state.readDesktopLaunchMode(), "ordinary");
  assert.equal(state.initialPhase("installed", true), "card");
  assert.equal(state.initialPhase("updated", true), "settled");
  assert.equal(state.initialPhase("ordinary", true), "done");
  assert.equal(state.initialPhase("installed", false), "done");
  assert.equal(state.initialPhase("updated", false), "done");
});

test("intro overlay cleans up timers and respects reduced motion", () => {
  assert.match(introSource, /return \(\) => window\.clearTimeout\(timer\)/u);
  assert.match(introSource, /window\.clearTimeout\(timer\)/u);
  assert.match(introCss, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(introCss, /transition: none !important/u);
  assert.match(introCss, /animation: none !important/u);
  assert.match(introCss, /pointer-events: auto/u);
});

test("launch failure releases the overlay without swallowing workbench errors", () => {
  assert.doesNotMatch(introSource, /alignFrameToHomeBackdrop|ui-agent-home__backdrop/u);
  assert.doesNotMatch(introSource, /catch\s*\(|retryBootstrap|bootstrapState/u);
  assert.doesNotMatch(introSource, /onInstallHandoffFailure|InstallHandoff/u);
});
