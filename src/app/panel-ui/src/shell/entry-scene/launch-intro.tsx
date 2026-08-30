import { useEffect, useMemo, useState } from "react";
import { useMotionEnabled } from "@ui/shell/motion-system";
import {
  CARD_HOLD_MS,
  CARD_MAX_WIDTH,
  EXPAND_MS,
  RELEASE_MS,
  SETTLED_HOLD_MS,
  UPDATED_SETTLE_MS,
  initialPhase,
  readDesktopLaunchMode,
  type DesktopLaunchMode,
  type LaunchIntroPhase,
} from "./launch-intro-state";
import { HOME_SCENE_ASPECT, renderHomeScene } from "./home-scene";
import "./home-scene.css";
import "./launch-intro.css";

// 首次启动动画使用独立覆盖层；主页背景保留既有完整构图。
const LAUNCH_SCENE = renderHomeScene({
  idPrefix: "ui-launch",
  preserveAspectRatio: "xMidYMid meet",
});

const CARD_FRAME_PADDING_MIN = 22;
const CARD_FRAME_PADDING_MAX = 32;
const CARD_FRAME_PADDING_RATIO = 0.025;
const CARD_FRAME_BOTTOM_EXTRA = 6;
const CARD_FRAME_BORDER = 1;
// Keep the small-window limit identical to .completion-frame in the installer
// (150vh - 137px). The extra room is the stage's fixed top/bottom breathing
// space, not an arbitrary crop of the canonical landscape.
const CARD_FRAME_HEIGHT_LIMIT_OFFSET = 137;

type LaunchFrameStyle = React.CSSProperties & {
  readonly "--launch-frame-padding": string;
  readonly "--launch-frame-bottom-padding": string;
};

function cardGeometry(): LaunchFrameStyle {
  // The installer and Electron use the same outer paper geometry. The scene
  // itself remains 3:2; only the paper inset absorbs the small-window limits.
  const padding = Math.min(
    CARD_FRAME_PADDING_MAX,
    Math.max(CARD_FRAME_PADDING_MIN, window.innerWidth * CARD_FRAME_PADDING_RATIO),
  );
  const bottomPadding = padding + CARD_FRAME_BOTTOM_EXTRA;
  const widthByHeight = window.innerHeight * HOME_SCENE_ASPECT - CARD_FRAME_HEIGHT_LIMIT_OFFSET;
  const width = Math.max(320, Math.min(CARD_MAX_WIDTH, window.innerWidth - 72, widthByHeight));
  const height =
    (width - padding * 2 - CARD_FRAME_BORDER * 2) / HOME_SCENE_ASPECT +
    padding + bottomPadding + CARD_FRAME_BORDER * 2;
  return {
    left: `${Math.round((window.innerWidth - width) / 2)}px`,
    top: `${Math.round((window.innerHeight - height) / 2)}px`,
    width: `${Math.round(width)}px`,
    height: `${Math.round(height)}px`,
    "--launch-frame-padding": `${padding}px`,
    "--launch-frame-bottom-padding": `${bottomPadding}px`,
  };
}

const fullGeometry: LaunchFrameStyle = {
  left: 0,
  top: 0,
  width: "100vw",
  height: "100vh",
  "--launch-frame-padding": "0px",
  "--launch-frame-bottom-padding": "0px",
};

export function LaunchIntro(): React.ReactElement | null {
  const mode = useMemo(readDesktopLaunchMode, []);
  const motionEnabled = useMotionEnabled();
  const [phase, setPhase] = useState<LaunchIntroPhase>(() => initialPhase(mode, motionEnabled));

  useEffect(() => {
    if (phase === "done") return;
    let timer: number | undefined;
    if (phase === "card") {
      timer = window.setTimeout(() => setPhase("expanding"), CARD_HOLD_MS);
    } else if (phase === "expanding") {
      timer = window.setTimeout(() => setPhase("settled"), EXPAND_MS);
    } else if (phase === "settled") {
      timer = window.setTimeout(
        () => setPhase("release"),
        mode === "installed" ? SETTLED_HOLD_MS : UPDATED_SETTLE_MS,
      );
    } else if (phase === "release") {
      timer = window.setTimeout(() => setPhase("done"), RELEASE_MS);
    }
    return () => window.clearTimeout(timer);
  }, [mode, phase]);

  if (phase === "done") return null;

  const geometry = mode === "installed" && phase === "card" ? cardGeometry() : fullGeometry;
  return (
    <div
      className={`launch-intro${phase === "release" ? " is-releasing" : ""}`}
      data-phase={phase}
      data-mode={mode}
      aria-hidden="true"
    >
      <div className="launch-intro__frame" style={geometry}>
        <span className="launch-intro__paper" aria-hidden="true">
          <span className="launch-intro__grain" />
          <span className="launch-intro__viewport">
            <span className="launch-intro__scene" dangerouslySetInnerHTML={{ __html: LAUNCH_SCENE }} />
            <span className="launch-intro__chrome" />
          </span>
        </span>
      </div>
    </div>
  );
}
