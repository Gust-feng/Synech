import { useEffect, useRef, useState } from "react";
import {
  consumeStreamingTextFrame,
  createInitialStreamingTextState,
  streamingTextHasPendingDisplay,
  updateStreamingTextTarget,
  type StreamingTextState,
  type StreamingTextTone,
} from "./streaming-text.js";

export type UseStreamingTextOptions = {
  /** 挂载时已有目标文本是否做一次动画回放；默认 false（回放/恢复不重放）。 */
  readonly animateOnMount?: boolean;
  /** 待显示积压超过该长度时跳过动画直接显示，避免超大跳变时无意义逐字。 */
  readonly maxAnimatedLength?: number;
  /** 思考根据分片到达间隔平滑；正文保留较短的显示延迟。 */
  readonly tone?: StreamingTextTone;
};

export const DEFAULT_STREAMING_ANIMATE_MAX_LENGTH = 4_000;

/**
 * 驱动流式文本的逐字平滑动画：返回「当前应显示」的文本。
 *
 * - 正文采用短平滑窗口；思考按分片间隔调整节奏，并限制最大滞后；
 * - 目标变为非前缀（终态替换、恢复、回放）时立即结算，不重放历史；
 * - 积压超过 maxAnimatedLength 后直接显示，避免无意义逐字；
 * - 无 rAF 环境（如旧 jsdom）下同步结算，保证组件可测试。
 */
export function useStreamingText(
  text: string,
  live: boolean,
  options?: UseStreamingTextOptions,
): string {
  const animateOnMount = options?.animateOnMount ?? false;
  const tone = options?.tone ?? "formal";
  const maxAnimatedLength = options?.maxAnimatedLength ?? DEFAULT_STREAMING_ANIMATE_MAX_LENGTH;
  const stateRef = useRef<StreamingTextState>(
    createInitialStreamingTextState(
      text,
      live && text.length <= maxAnimatedLength && typeof requestAnimationFrame === "function",
      animateOnMount,
      Date.now(),
      tone,
    ),
  );
  const frameRef = useRef<number | undefined>(undefined);
  const [displayed, setDisplayed] = useState<string>(stateRef.current.displayed);

  useEffect(() => {
    const animatable = live && text.length - stateRef.current.displayed.length <= maxAnimatedLength &&
      typeof requestAnimationFrame === "function";
    const next = updateStreamingTextTarget(stateRef.current, text, animatable, Date.now(), tone);
    stateRef.current = next;
    setDisplayed(next.displayed);
    if (!streamingTextHasPendingDisplay(next)) {
      return;
    }
    let cancelled = false;
    const tick = (): void => {
      if (cancelled) {
        return;
      }
      const state = consumeStreamingTextFrame(stateRef.current, Date.now());
      stateRef.current = state;
      setDisplayed(state.displayed);
      if (streamingTextHasPendingDisplay(state)) {
        frameRef.current = requestStreamingFrame(tick);
      }
    };
    frameRef.current = requestStreamingFrame(tick);
    return () => {
      cancelled = true;
      if (frameRef.current !== undefined) {
        cancelStreamingFrame(frameRef.current);
        frameRef.current = undefined;
      }
    };
  }, [text, live, maxAnimatedLength, animateOnMount, tone]);

  return displayed;
}

function requestStreamingFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  callback();
  return 0;
}

function cancelStreamingFrame(handle: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(handle);
  }
}
