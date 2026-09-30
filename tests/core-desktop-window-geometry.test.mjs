import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WORKBENCH_FALLBACK_HEIGHT,
  DEFAULT_WORKBENCH_FALLBACK_WIDTH,
  DEFAULT_WORKBENCH_MIN_HEIGHT,
  DEFAULT_WORKBENCH_MIN_WIDTH,
  WORKBENCH_ASPECT_RATIO,
  calculateProportionalWorkbenchGeometry,
} from "../dist/app/desktop/panel-desktop-window-geometry.js";

test("desktop window geometry: returns safe fallbacks for missing or invalid work area", () => {
  assert.deepEqual(calculateProportionalWorkbenchGeometry(), {
    width: DEFAULT_WORKBENCH_FALLBACK_WIDTH,
    height: DEFAULT_WORKBENCH_FALLBACK_HEIGHT,
    minWidth: DEFAULT_WORKBENCH_MIN_WIDTH,
    minHeight: DEFAULT_WORKBENCH_MIN_HEIGHT,
  });

  assert.deepEqual(calculateProportionalWorkbenchGeometry(null), {
    width: DEFAULT_WORKBENCH_FALLBACK_WIDTH,
    height: DEFAULT_WORKBENCH_FALLBACK_HEIGHT,
    minWidth: DEFAULT_WORKBENCH_MIN_WIDTH,
    minHeight: DEFAULT_WORKBENCH_MIN_HEIGHT,
  });

  assert.deepEqual(calculateProportionalWorkbenchGeometry({ width: 0, height: 0 }), {
    width: DEFAULT_WORKBENCH_FALLBACK_WIDTH,
    height: DEFAULT_WORKBENCH_FALLBACK_HEIGHT,
    minWidth: DEFAULT_WORKBENCH_MIN_WIDTH,
    minHeight: DEFAULT_WORKBENCH_MIN_HEIGHT,
  });
});

test("desktop window geometry: scales strictly 16:9 on user screen (1707x960) without maxing out height", () => {
  const geometry = calculateProportionalWorkbenchGeometry({ width: 1707, height: 960 });
  assert.equal(geometry.width, 1365);
  assert.equal(geometry.height, 768);
  assert.equal(geometry.minWidth, 960);
  assert.equal(geometry.minHeight, 640);

  // 严格验证 16:9 比例 (误差在 1 像素以内)
  const ratio = geometry.width / geometry.height;
  assert.ok(Math.abs(ratio - WORKBENCH_ASPECT_RATIO) < 0.001);

  // 验证上下留白约 10%
  const topBottomMargin = (960 - geometry.height) / 2;
  assert.equal(topBottomMargin, 96);
  assert.equal(topBottomMargin / 960, 0.1);
});

test("desktop window geometry: strictly maintains 16:9 on standard 1080p display with taskbar", () => {
  const geometry = calculateProportionalWorkbenchGeometry({ width: 1920, height: 1040 });
  assert.equal(geometry.height, 832);
  assert.equal(geometry.width, 1479);
  const ratio = geometry.width / geometry.height;
  assert.ok(Math.abs(ratio - WORKBENCH_ASPECT_RATIO) < 0.001);
});

test("desktop window geometry: strictly maintains 16:9 on ultrawide displays", () => {
  const geometry = calculateProportionalWorkbenchGeometry({ width: 3440, height: 1400 });
  assert.equal(geometry.height, 1120);
  assert.equal(geometry.width, 1991);
  const ratio = geometry.width / geometry.height;
  assert.ok(Math.abs(ratio - WORKBENCH_ASPECT_RATIO) < 0.001);
});

test("desktop window geometry: strictly maintains 16:9 on 16:10 screens", () => {
  const geometry = calculateProportionalWorkbenchGeometry({ width: 1920, height: 1200 });
  assert.equal(geometry.width, 1536);
  assert.equal(geometry.height, 864);
  const ratio = geometry.width / geometry.height;
  assert.ok(Math.abs(ratio - WORKBENCH_ASPECT_RATIO) < 0.0001);
});

test("desktop window geometry: respects minimum width and height on small displays", () => {
  const geometry = calculateProportionalWorkbenchGeometry({ width: 1280, height: 680 });
  assert.ok(geometry.width >= 960);
  assert.ok(geometry.height >= 640);
});

test("desktop window geometry: handles portrait orientation displays", () => {
  const geometry = calculateProportionalWorkbenchGeometry({ width: 1080, height: 1880 });
  assert.equal(geometry.width, 1080);
  assert.equal(geometry.height, 640);
  assert.ok(geometry.height >= 640);
});
