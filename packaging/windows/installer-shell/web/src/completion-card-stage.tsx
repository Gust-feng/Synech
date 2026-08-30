import type { DotLottie } from "@lottiefiles/dotlottie-web";
import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { renderHomeScene } from "@synech/scene";
import completionConfettiAsset from "./assets/completion-confetti.lottie?url";
import dotLottieWasmUrl from "@lottiefiles/dotlottie-web/dotlottie-player.wasm?url";

// 场景入口与安装器窗口同属一个安静构图：入口自身保持 3:2，
// 完整承载 canonical 1440×960 场景，不做任何局部裁剪。
const SCENE_ENTRY_SCENE = renderHomeScene({
  idPrefix: "installer-card",
  variant: "light",
  preserveAspectRatio: "xMidYMid meet",
});

// 彩带相对场景入口稍晚开始：入口先稳定存在，彩带只是前景的一次庆祝。
const CONFETTI_START_DELAY_MS = 420;
const CONFETTI_FALLBACK_MS = 1200;
const LAUNCH_RETRY_GUARD_MS = 1600;

export function CompletionCardStage(props: {
  readonly visible: boolean;
  readonly reduceMotion: boolean;
  readonly onLaunch: () => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [confettiDone, setConfettiDone] = useState(false);
  const openedRef = useRef(false);
  const launchRetryTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!props.visible) {
      // 新的安装尝试会重置整个完成场景：彩带与入口状态都从头开始。
      setConfettiDone(false);
      openedRef.current = false;
      window.clearTimeout(launchRetryTimerRef.current);
      launchRetryTimerRef.current = undefined;
    }
  }, [props.visible]);

  useEffect(() => {
    return () => window.clearTimeout(launchRetryTimerRef.current);
  }, []);

  // 彩带只在完成场景播放一次；结束（或加载失败兜底）后不再追加任何爆发。
  useEffect(() => {
    if (!props.visible || props.reduceMotion) {
      if (props.visible && props.reduceMotion) setConfettiDone(true);
      return;
    }
    let disposed = false;
    let player: DotLottie | undefined;
    let startTimer: number | undefined;
    let fallbackTimer: number | undefined;

    const finish = (): void => {
      if (disposed) return;
      window.clearTimeout(fallbackTimer);
      setConfettiDone(true);
    };
    const onLoadError = (): void => {
      if (disposed) return;
      // 资源已随安装器分发；异常时安静收尾，不阻塞卡片交互。
      fallbackTimer = window.setTimeout(finish, CONFETTI_FALLBACK_MS);
    };
    const start = async (): Promise<void> => {
      const { DotLottie: DotLottieRuntime } = await import("@lottiefiles/dotlottie-web");
      if (disposed) return;
      const canvas = canvasRef.current;
      if (canvas === null) {
        finish();
        return;
      }
      DotLottieRuntime.setWasmUrl(dotLottieWasmUrl);
      player = new DotLottieRuntime({
        autoplay: true,
        backgroundColor: "transparent",
        canvas,
        layout: { align: [0.5, 0.5], fit: "cover" },
        loop: false,
        renderConfig: { autoResize: true, devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2) },
        src: completionConfettiAsset,
      });
      player.addEventListener("complete", finish);
      player.addEventListener("loadError", onLoadError);
    };
    startTimer = window.setTimeout(() => void start().catch(onLoadError), CONFETTI_START_DELAY_MS);

    return () => {
      disposed = true;
      window.clearTimeout(startTimer);
      window.clearTimeout(fallbackTimer);
      player?.removeEventListener("complete", finish);
      player?.removeEventListener("loadError", onLoadError);
      player?.destroy();
    };
  }, [props.visible, props.reduceMotion]);

  const handleOpen = (): void => {
    if (openedRef.current) return;
    openedRef.current = true;
    // 只提交一次启动命令；安装器不负责应用窗口的生命周期和启动动画。
    props.onLaunch();
    // 启动成功时窗口会很快关闭；若启动失败窗口仍在，恢复卡片允许再次尝试。
    window.clearTimeout(launchRetryTimerRef.current);
    launchRetryTimerRef.current = window.setTimeout(() => {
      openedRef.current = false;
      launchRetryTimerRef.current = undefined;
    }, LAUNCH_RETRY_GUARD_MS);
  };

  const stageClass = [
    "completion-stage",
    props.visible ? "is-visible" : "is-hidden",
    confettiDone ? "is-confetti-done" : "",
  ].filter((token) => token !== "").join(" ");

  return (
    <section
      className={stageClass}
      aria-hidden={!props.visible}
      aria-label="安装完成，打开 Synech"
    >
      <div className="completion-backdrop" aria-hidden="true">
        <span className="completion-backdrop__grain" />
        <svg
          className="completion-backdrop__marks"
          viewBox="0 0 1000 660"
          preserveAspectRatio="none"
          focusable="false"
        >
          <g className="completion-backdrop__corners">
            <path d="M28 24h38M28 24v34" />
            <path d="M30 636h38M30 636v-34" />
            <path d="M970 636h-38M970 636v-34" />
          </g>
          <g className="completion-backdrop__contours">
            <path d="M-34 432C59 416 74 471 153 480c103 12 152 95 266 128" />
            <path d="M-40 468c85-16 111 43 177 52 105 14 149 84 258 110" />
            <path d="M1003 328c-74-38-96 43-149 34-44-8-56 47-111 39" />
            <path d="M1005 370c-69-32-91 42-141 35-45-6-56 44-106 37" />
            <path d="M702 83c91-42 180-18 198 50 8 31 4 64-5 92" />
          </g>
          <g className="completion-backdrop__dots">
            <circle cx="28" cy="80" r="1.65" />
            <circle cx="28" cy="91" r="1.65" />
            <circle cx="28" cy="102" r="1.65" />
            <circle cx="28" cy="113" r="1.65" />
            <circle cx="970" cy="532" r="1.65" />
            <circle cx="970" cy="543" r="1.65" />
            <circle cx="970" cy="554" r="1.65" />
            <circle cx="970" cy="565" r="1.65" />
          </g>
          <g className="completion-backdrop__pinpoints">
            <circle cx="136" cy="96" r="1.1" />
            <circle cx="191" cy="553" r="1.25" />
            <circle cx="705" cy="58" r="1" />
            <circle cx="835" cy="116" r="1.45" />
            <circle cx="970" cy="585" r="1.05" />
          </g>
        </svg>
      </div>
      <button
        className="completion-close"
        type="button"
        aria-label="关闭安装器"
        title="关闭"
        disabled={!props.visible}
        onClick={props.onClose}
      >
        <span aria-hidden="true" />
      </button>
      <div className="completion-frame">
        <span className="completion-frame__grain" aria-hidden="true" />
        <button
          className="scene-entry"
          type="button"
          aria-label="打开 Synech"
          onClick={handleOpen}
          disabled={!props.visible}
        >
          <span className="scene-entry__viewport" aria-hidden="true">
            <span className="scene-entry__scene" dangerouslySetInnerHTML={{ __html: SCENE_ENTRY_SCENE }} />
          </span>
          <span className="scene-entry__tab" aria-hidden="true">
            <span className="scene-entry__tab-action">
              <span>打开 Synech</span>
              <ArrowRight size={13} strokeWidth={1.6} />
            </span>
          </span>
          <span className="scene-entry__frame" aria-hidden="true" />
        </button>
      </div>
      <canvas ref={canvasRef} className="completion-confetti" aria-hidden="true" />
    </section>
  );
}
