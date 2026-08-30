/**
 * Synech 唯一场景源：天空、太阳、飞鸟、三层远山。
 *
 * 主页背景（HomeBackdrop）、安装器礼品卡与首次启动动画都必须经由本模块
 * 输出场景，不允许维护第二套坐标或构图。画布固定为 1440×960（3:2），
 * 与主窗口和礼品卡同比例，保证整卡、整窗呈现时不裁剪任何元素。
 */

export const HOME_SCENE_WIDTH = 1440;
export const HOME_SCENE_HEIGHT = 960;
export const HOME_SCENE_ASPECT = HOME_SCENE_WIDTH / HOME_SCENE_HEIGHT;

export type HomeSceneVariant = "light" | "dark" | "both";

type HomeSceneLayer =
  | "sky"
  | "sun"
  | "birds"
  | "mountains-far"
  | "mountains-mid"
  | "mountains-near";

export type HomeSceneRenderOptions = {
  /** 渐变 id 前缀；同页多实例必须使用不同前缀避免 defs 冲突。 */
  readonly idPrefix?: string;
  readonly variant?: HomeSceneVariant;
  readonly preserveAspectRatio?: string;
};

export function renderHomeScene(options: HomeSceneRenderOptions = {}): string {
  const idPrefix = options.idPrefix ?? "ui-home";
  const variant = options.variant ?? "both";
  const preserveAspectRatio = options.preserveAspectRatio ?? "xMidYMid meet";
  const includesLight = variant === "light" || variant === "both";
  const includesDark = variant === "dark" || variant === "both";
  const groups = [
    includesLight ? renderLightVariant(idPrefix) : "",
    includesDark ? renderDarkVariant(idPrefix) : "",
  ].join("");
  return (
    `<svg class="home-scene" viewBox="0 0 ${HOME_SCENE_WIDTH} ${HOME_SCENE_HEIGHT}"` +
    ` preserveAspectRatio="${preserveAspectRatio}" width="100%" height="100%" focusable="false" aria-hidden="true">` +
    `<defs>${renderDefs(idPrefix, includesLight, includesDark)}</defs>${groups}</svg>`
  );
}

function layerClass(layer: HomeSceneLayer): string {
  return ` class="home-scene__layer" data-scene-layer="${layer}"`;
}

function renderDefs(idPrefix: string, includesLight: boolean, includesDark: boolean): string {
  const light = includesLight
    ? `<linearGradient id="${idPrefix}-light-sky" x1="0" y1="0" x2="0" y2="1">` +
      '<stop offset="0" stop-color="#efeaf6"/>' +
      '<stop offset="0.34" stop-color="#f1edf4"/>' +
      '<stop offset="0.64" stop-color="#f4f1ee"/>' +
      '<stop offset="1" stop-color="#f4f2ef"/>' +
      "</linearGradient>" +
      `<radialGradient id="${idPrefix}-light-sun" cx="0.5" cy="0.5" r="0.5">` +
      '<stop offset="0" stop-color="#faf0e2"/>' +
      '<stop offset="0.42" stop-color="#f7ecdd" stop-opacity="0.9"/>' +
      '<stop offset="1" stop-color="#f7ecdd" stop-opacity="0"/>' +
      "</radialGradient>" +
      `<linearGradient id="${idPrefix}-light-far-mountain" x1="0" y1="0" x2="0.9" y2="1">` +
      '<stop offset="0" stop-color="#6865a7" stop-opacity="0.08"/>' +
      '<stop offset="1" stop-color="#6865a7" stop-opacity="0.08"/>' +
      "</linearGradient>" +
      `<linearGradient id="${idPrefix}-light-mid-mountain" x1="0" y1="0" x2="0.8" y2="1">` +
      '<stop offset="0" stop-color="#7a967c" stop-opacity="0.12"/>' +
      '<stop offset="1" stop-color="#7a967c" stop-opacity="0.12"/>' +
      "</linearGradient>" +
      `<linearGradient id="${idPrefix}-light-near-mountain" x1="0" y1="0" x2="0.8" y2="1">` +
      '<stop offset="0" stop-color="#607464" stop-opacity="0.16"/>' +
      '<stop offset="1" stop-color="#607464" stop-opacity="0.16"/>' +
      "</linearGradient>"
    : "";
  const dark = includesDark
    ? `<linearGradient id="${idPrefix}-night-paper" x1="0" y1="0" x2="0" y2="1">` +
      '<stop offset="0" stop-color="#22242c"/>' +
      '<stop offset="0.46" stop-color="#1f2128"/>' +
      '<stop offset="1" stop-color="#1b1b20"/>' +
      "</linearGradient>" +
      `<linearGradient id="${idPrefix}-night-sheet-a" x1="0" y1="0" x2="1" y2="1">` +
      '<stop offset="0" stop-color="#45475a"/>' +
      '<stop offset="1" stop-color="#3a3c4d"/>' +
      "</linearGradient>" +
      `<linearGradient id="${idPrefix}-night-sheet-b" x1="0" y1="0" x2="0.9" y2="1">` +
      '<stop offset="0" stop-color="#30353e"/>' +
      '<stop offset="1" stop-color="#2a2f36"/>' +
      "</linearGradient>"
    : "";
  return light + dark;
}

function renderLightVariant(idPrefix: string): string {
  return (
    '<g class="home-scene__variant home-scene__variant--light">' +
    `<g${layerClass("sky")}>` +
    `<rect width="${HOME_SCENE_WIDTH}" height="${HOME_SCENE_HEIGHT}" fill="url(#${idPrefix}-light-sky)"/>` +
    "</g>" +
    `<g${layerClass("sun")}>` +
    `<circle cx="1090" cy="250" r="240" fill="url(#${idPrefix}-light-sun)"/>` +
    '<circle cx="1090" cy="250" r="52" fill="#f8efdb"/>' +
    "</g>" +
    // 保留原始天空中的极淡层次，但用弧形边界避免出现一条生硬的色带。
    `<path d="M0 392 C360 384 720 405 1080 390 C1230 384 1350 389 1440 392 L1440 512 C1110 504 760 520 430 507 C250 500 110 506 0 512 Z" fill="#6865a7" fill-opacity="0.04"/>` +
    `<g${layerClass("birds")} fill="none" stroke="rgba(110,103,132,0.45)" stroke-linecap="round" stroke-width="2.4">` +
    '<path d="M732 84 q15 -13 30 0 q15 -13 30 0"/>' +
    '<path d="M806 116 q11 -9 22 0 q11 -9 22 0"/>' +
    '<path d="M696 138 q8 -7 16 0 q8 -7 16 0"/>' +
    "</g>" +
    `<g${layerClass("mountains-far")}>` +
    `<path d="M0 486 C240 430 420 448 620 424 C840 398 1060 424 1240 408 C1340 399 1410 410 1440 404 L1440 ${HOME_SCENE_HEIGHT} L0 ${HOME_SCENE_HEIGHT} Z" fill="url(#${idPrefix}-light-far-mountain)"/>` +
    "</g>" +
    `<g${layerClass("mountains-mid")}>` +
    `<path d="M0 566 C220 512 400 528 600 506 C820 482 1020 512 1220 496 C1330 487 1400 506 1440 498 L1440 ${HOME_SCENE_HEIGHT} L0 ${HOME_SCENE_HEIGHT} Z" fill="url(#${idPrefix}-light-mid-mountain)"/>` +
    "</g>" +
    `<g${layerClass("mountains-near")}>` +
    `<path d="M0 650 C200 602 380 626 580 612 C800 597 1020 628 1220 616 C1330 609 1400 628 1440 620 L1440 ${HOME_SCENE_HEIGHT} L0 ${HOME_SCENE_HEIGHT} Z" fill="url(#${idPrefix}-light-near-mountain)"/>` +
    "</g>" +
    "</g>"
  );
}

function renderDarkVariant(idPrefix: string): string {
  return (
    '<g class="home-scene__variant home-scene__variant--dark">' +
    `<g${layerClass("sky")}>` +
    `<rect width="${HOME_SCENE_WIDTH}" height="${HOME_SCENE_HEIGHT}" fill="url(#${idPrefix}-night-paper)"/>` +
    '<path d="M0 382 C254 357 486 374 720 388 C962 403 1194 382 1440 397 L1440 468 C1174 455 968 470 722 455 C478 440 248 446 0 464 Z" fill="#918ba0" fill-opacity="0.018"/>' +
    "</g>" +
    `<g${layerClass("mountains-far")}>` +
    `<path d="M0 430 C228 392 420 418 620 402 C850 383 1060 420 1260 406 C1360 399 1420 408 1440 404 L1440 960 L0 960 Z" fill="url(#${idPrefix}-night-sheet-a)" fill-opacity="0.66"/>` +
    "</g>" +
    `<g${layerClass("mountains-mid")}>` +
    `<path d="M0 560 C220 520 408 548 606 532 C830 514 1040 550 1240 538 C1350 531 1412 547 1440 542 L1440 960 L0 960 Z" fill="url(#${idPrefix}-night-sheet-b)" fill-opacity="0.72"/>` +
    "</g>" +
    `<g${layerClass("mountains-near")}>` +
    '<path d="M0 700 C210 666 392 692 588 682 C806 670 1020 700 1218 688 C1332 681 1402 698 1440 692 L1440 960 L0 960 Z" fill="#292c33" fill-opacity="0.68"/>' +
    "</g>" +
    "</g>"
  );
}
