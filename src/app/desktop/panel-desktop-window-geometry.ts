export type DisplayWorkArea = {
  readonly width: number;
  readonly height: number;
  readonly x?: number;
  readonly y?: number;
};

export type WorkbenchGeometry = {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
};

export const WORKBENCH_ASPECT_RATIO = 16 / 9;
export const WORKBENCH_SCREEN_RATIO = 0.80;
export const DEFAULT_WORKBENCH_MIN_WIDTH = 960;
export const DEFAULT_WORKBENCH_MIN_HEIGHT = 640;
export const DEFAULT_WORKBENCH_FALLBACK_WIDTH = 1365;
export const DEFAULT_WORKBENCH_FALLBACK_HEIGHT = 768;

export const DESKTOP_WORKBENCH_WIDTH = DEFAULT_WORKBENCH_FALLBACK_WIDTH;
export const DESKTOP_WORKBENCH_HEIGHT = DEFAULT_WORKBENCH_FALLBACK_HEIGHT;

/**
 * 根据屏幕可用工作区（排除任务栏/Dock等系统区域）动态计算严格 16:9 居中窗口尺寸。
 *
 * 核心设计：
 * 1. 严格遵循 16:9 黄金宽屏宽高比（WORKBENCH_ASPECT_RATIO = 16 / 9）。
 * 2. 默认占屏幕可用空间的约 80%，使居中后四周留出舒适均匀的呼吸边距（上下各约 10%）。
 * 3. 当屏幕宽度充裕（如 16:9 屏、超宽带鱼屏 21:9 等）时，以高度的 80% 为基准轴，按 16:9 换算宽度，防止横向拉伸过度。
 * 4. 当屏幕较窄或竖屏时，以宽度的 80%（竖屏为 90%）为基准轴，按 16:9 换算高度。
 * 5. 严格满足 minWidth(960) 和 minHeight(640) 的最小可用约束。
 */
export function calculateProportionalWorkbenchGeometry(
  workArea?: DisplayWorkArea | null,
): WorkbenchGeometry {
  if (
    !workArea ||
    typeof workArea.width !== "number" ||
    typeof workArea.height !== "number" ||
    workArea.width <= 0 ||
    workArea.height <= 0
  ) {
    return {
      width: DEFAULT_WORKBENCH_FALLBACK_WIDTH,
      height: DEFAULT_WORKBENCH_FALLBACK_HEIGHT,
      minWidth: DEFAULT_WORKBENCH_MIN_WIDTH,
      minHeight: DEFAULT_WORKBENCH_MIN_HEIGHT,
    };
  }

  const screenWidth = Math.round(workArea.width);
  const screenHeight = Math.round(workArea.height);

  let targetWidth: number;
  let targetHeight: number;

  if (screenWidth / screenHeight >= WORKBENCH_ASPECT_RATIO) {
    targetHeight = Math.round(screenHeight * WORKBENCH_SCREEN_RATIO);
    targetWidth = Math.round(targetHeight * WORKBENCH_ASPECT_RATIO);
  } else {
    const widthRatio = screenWidth < screenHeight ? 0.90 : WORKBENCH_SCREEN_RATIO;
    targetWidth = Math.round(screenWidth * widthRatio);
    targetHeight = Math.round(targetWidth / WORKBENCH_ASPECT_RATIO);
  }

  if (targetHeight < DEFAULT_WORKBENCH_MIN_HEIGHT) {
    targetHeight = Math.min(screenHeight, DEFAULT_WORKBENCH_MIN_HEIGHT);
    targetWidth = Math.min(screenWidth, Math.round(targetHeight * WORKBENCH_ASPECT_RATIO));
  }
  if (targetWidth < DEFAULT_WORKBENCH_MIN_WIDTH) {
    targetWidth = Math.min(screenWidth, DEFAULT_WORKBENCH_MIN_WIDTH);
    targetHeight = Math.min(screenHeight, Math.round(targetWidth / WORKBENCH_ASPECT_RATIO));
  }

  const width = Math.min(screenWidth, targetWidth);
  const height = Math.min(screenHeight, targetHeight);

  return {
    width,
    height,
    minWidth: Math.min(DEFAULT_WORKBENCH_MIN_WIDTH, width),
    minHeight: Math.min(DEFAULT_WORKBENCH_MIN_HEIGHT, height),
  };
}
