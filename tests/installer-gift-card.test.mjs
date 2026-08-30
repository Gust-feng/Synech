import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const cardSource = readFileSync(
  "packaging/windows/installer-shell/web/src/completion-card-stage.tsx",
  "utf8",
);
const styles = readFileSync("packaging/windows/installer-shell/web/src/styles.css", "utf8");
const sceneSource = readFileSync(
  "src/app/panel-ui/src/shell/entry-scene/home-scene.ts",
  "utf8",
);
const nativeSource = readFileSync("packaging/windows/installer-shell/src/main.cpp", "utf8");

test("scene entry uses the complete landscape scene with no local crop", () => {
  // 卡片与安装器共用同一场景源：不维护第二套坐标。
  assert.match(cardSource, /@synech\/scene/u);
  assert.match(cardSource, /renderHomeScene\(/u);
  assert.match(cardSource, /variant: "light"/u);
  assert.match(cardSource, /preserveAspectRatio: "xMidYMid meet"/u);
  // 场景入口自身是标准 3:2，完整承载 1440×960 场景；宽度还受小安装器高度约束。
  assert.match(styles, /aspect-ratio: 3 \/ 2/u);
  assert.match(styles, /\.completion-frame\s*\{[\s\S]*?width:\s*min\(780px, calc\(100vw - 72px\), calc\(150vh - 137px\)\)/u);
  assert.match(styles, /\.scene-entry\s*\{[\s\S]*?width:\s*100%/u);
  assert.match(sceneSource, /viewBox="0 0 \$\{HOME_SCENE_WIDTH\} \$\{HOME_SCENE_HEIGHT\}"/u);
  // 不包含局部裁剪逻辑：卡片源码里的 path 只属于外围规划线，
  // 共享景观仍由 renderHomeScene 输出，且没有 slice/裁剪视口。
  assert.match(cardSource, /completion-backdrop__contours/u);
  assert.doesNotMatch(cardSource, /preserveAspectRatio=["'][^"']*slice/u);
  assert.doesNotMatch(cardSource, /clip-path/u);
});

test("completion background recreates the quiet reference field with code-drawn marks", () => {
  // 景观只存在于卡片里；外围是静态渐变色场、等高线、角标和少量点位。
  assert.match(styles, /--completion-background\s*:\s*[\s\S]*?radial-gradient/u);
  assert.match(styles, /\.completion-stage\s*\{[\s\S]*?background:\s*var\(--completion-background\)/u);
  assert.match(cardSource, /className="completion-backdrop"\s+aria-hidden="true"/u);
  assert.match(cardSource, /className="completion-backdrop__marks"/u);
  assert.match(cardSource, /viewBox="0 0 1000 660"/u);
  assert.match(cardSource, /completion-backdrop__corners/u);
  assert.match(cardSource, /completion-backdrop__contours/u);
  assert.match(cardSource, /completion-backdrop__dots/u);
  assert.doesNotMatch(cardSource, /SCENE_BACKDROP_SCENE|completion-backdrop__scene/u);
  assert.match(styles, /\.completion-backdrop\s*\{[\s\S]*?pointer-events:\s*none/u);
  assert.match(styles, /\.completion-backdrop__grain\s*\{[\s\S]*?background-image:\s*var\(--completion-paper-grain\)/u);
  assert.match(styles, /\.completion-backdrop__marks\s*\{[\s\S]*?pointer-events:\s*none/u);
  assert.match(styles, /\.completion-backdrop__corners\s*\{[\s\S]*?stroke:/u);
  assert.match(styles, /\.completion-backdrop__contours\s*\{[\s\S]*?vector-effect:\s*non-scaling-stroke/u);
  assert.doesNotMatch(styles, /\.completion-backdrop(?:__scene)?[^{}]*\{[^}]*\b(?:animation|transition)\s*:/u);
  assert.match(cardSource, /className="completion-frame"/u);
  assert.match(styles, /--completion-frame-bottom-padding:\s*calc\(var\(--completion-frame-padding\) \+ 6px\)/u);
  assert.match(styles, /--completion-paper-grain:\s*url\([^;]+feTurbulence/u);
  assert.match(styles, /\.completion-frame::before\s*\{[\s\S]*?inset:\s*var\(--completion-frame-padding\) var\(--completion-frame-padding\) var\(--completion-frame-bottom-padding\)/u);
  assert.match(styles, /\.completion-frame::after\s*\{[\s\S]*?border-right-color:[^;]+;[\s\S]*?border-bottom-color:/u);
  assert.match(styles, /\.completion-frame__grain\s*\{[\s\S]*?background-image:\s*var\(--completion-paper-grain\)[\s\S]*?background-size:\s*240px 240px[\s\S]*?opacity:\s*0\.035/u);
  assert.doesNotMatch(styles, /\.scene-entry__viewport::after/u);
  assert.doesNotMatch(styles, /\.completion-frame__grain[^{}]*\{[^}]*\b(?:animation|transition)\s*:/u);
  assert.doesNotMatch(styles, /scene-entry-enter|\.completion-stage\.is-visible\s+\.scene-entry/u);
});

test("ribbon plays once over the card and never spawns a second burst", () => {
  assert.match(cardSource, /loop: false/u);
  assert.match(cardSource, /addEventListener\("complete", finish\)/u);
  assert.match(cardSource, /setConfettiDone\(true\)/u);
  // 单次播放：没有 restart/goToAndPlay/setSpeed/重复 loop。
  assert.doesNotMatch(cardSource, /goToAndPlay|goToAndStop|restart|setSpeed|repeatCount|loop: true/u);
  // 结束后画布收场并隐藏。
  assert.match(styles, /\.completion-stage\.is-confetti-done \.completion-confetti/u);
  assert.match(styles, /visibility: hidden/u);
  // 完成场景只创建一个播放器实例，且销毁清理。
  assert.equal((cardSource.match(/new DotLottieRuntime\(/gu) ?? []).length, 1);
  assert.match(cardSource, /player\?\.destroy\(\)/u);
});

test("clicking the card is the only way app.open is submitted", () => {
  // 点击处理器直接提交启动命令，不依赖动画完成、也不由计时器触发。
  assert.match(cardSource, /props\.onLaunch\(\)/u);
  assert.match(cardSource, /openedRef/u);
  assert.doesNotMatch(cardSource, /setTimeout\([\s\S]{0,100}props\.onLaunch/u);
  assert.doesNotMatch(cardSource, /autoLaunch|安装完成后自动打开/u);
  // 原生侧只在收到用户命令 app.open 时启动。
  assert.match(nativeSource, /if \(type == L"app\.open"\)/u);
  assert.doesNotMatch(nativeSource, /PostPhase\(L"completed"\);\s*LaunchVerifiedApplication/u);
});

test("completion keeps a secondary close path without adding another primary action", () => {
  assert.match(cardSource, /className="completion-close"/u);
  assert.match(cardSource, /aria-label="关闭安装器"/u);
  assert.match(cardSource, /onClick=\{props\.onClose\}/u);
  assert.doesNotMatch(cardSource, /scene-entry__status/u);
  assert.doesNotMatch(styles, /\.scene-entry__status/u);
  assert.match(styles, /\.scene-entry__tab\s*\{[\s\S]*?border-top:[^;]+;[\s\S]*?border-bottom:[^;]+;/u);
  assert.match(styles, /\.scene-entry__tab::before/u);
  assert.match(styles, /\.scene-entry__tab\s*\{[\s\S]*?min-height:\s*44px/u);
  assert.match(cardSource, /scene-entry__tab-action/u);
  assert.match(styles, /\.completion-close[\s\S]*?width: 44px[\s\S]*?height: 44px/u);
});

test("reduced motion cancels confetti without interactive motion states", () => {
  // 彩带：reduced-motion 下直接进入完成态，不启动播放器。
  assert.match(cardSource, /if \(props\.visible && props\.reduceMotion\) setConfettiDone\(true\)/u);
  // 完成卡片保持静态：不注册指针监听、不调度逐帧视差，也不引用视差常量。
  assert.doesNotMatch(cardSource, /pointermove|pointerleave|requestAnimationFrame/u);
  assert.doesNotMatch(cardSource, /HOME_SCENE_PARALLAX_FACTORS|HOME_SCENE_CARD_MAX_POINTER_SHIFT/u);
  // 点击：只提交启动命令，不在安装器本地播放按压/放大动画。
  assert.match(cardSource, /props\.onLaunch\(\);/u);
  assert.doesNotMatch(cardSource, /setOpenState|PRESS_HOLD_MS|is-pressed|is-opening/u);
});

test("completion card stays static while retaining lifecycle cleanup", () => {
  // 静态卡片不应留下指针监听、动画帧或视差常量引用。
  assert.doesNotMatch(cardSource, /pointermove|pointerleave|requestAnimationFrame|cancelAnimationFrame/u);
  assert.doesNotMatch(cardSource, /HOME_SCENE_PARALLAX_FACTORS|HOME_SCENE_CARD_MAX_POINTER_SHIFT/u);
  assert.match(cardSource, /window\.clearTimeout\(launchRetryTimerRef\.current\)/u);
  assert.match(cardSource, /player\?\.removeEventListener/u);
  assert.match(cardSource, /window\.clearTimeout\(startTimer\)/u);
  // 悬浮不改变卡片位置，也不触发 frame/tab 的局部动画；入场动效只属于完成卡片本身。
  assert.doesNotMatch(styles, /\.scene-entry:hover[^{}]*\{[^}]*\btransform\s*:/u);
  assert.doesNotMatch(styles, /\.scene-entry:hover\s+\.scene-entry__(?:frame|tab)(?:::before)?/u);
  assert.doesNotMatch(styles, /scene-entry-enter|\.completion-stage\.is-visible\s+\.scene-entry/u);
});
