export type StreamingTextTone = "formal" | "process" | "thinking";

const STREAM_SMOOTH_WINDOW_MS = 90;
const STREAM_MAX_LAG_MS = 160;
const ESTIMATED_FRAME_MS = 1000 / 60;

export type StreamingTextState = {
  readonly target: string;
  readonly displayed: string;
  readonly animationStartedAt?: number;
  readonly deadlineAt?: number;
};

export function createStreamingTextState(text = ""): StreamingTextState {
  return {
    target: text,
    displayed: text,
  };
}

export function createInitialStreamingTextState(
  text: string,
  live: boolean,
  animateOnMount: boolean,
  now: number,
): StreamingTextState {
  if (!live || !animateOnMount || text.length === 0) {
    return createStreamingTextState(text);
  }
  return consumeStreamingTextFrame(
    updateStreamingTextTarget(createStreamingTextState(), text, true, now),
    now,
  );
}

export function updateStreamingTextTarget(
  state: StreamingTextState,
  target: string,
  live: boolean,
  now: number,
): StreamingTextState {
  if (!live) {
    return createStreamingTextState(target);
  }
  if (target === state.target) {
    return state;
  }
  if (state.target.startsWith(target)) {
    return state;
  }
  if (!target.startsWith(state.displayed)) {
    return createStreamingTextState(target);
  }

  const smoothing = state.displayed.length < state.target.length &&
    state.animationStartedAt !== undefined &&
    state.deadlineAt !== undefined;
  const animationStartedAt = smoothing ? state.animationStartedAt : now;
  const deadlineAt = smoothing
    ? Math.min(
        animationStartedAt + STREAM_MAX_LAG_MS,
        Math.max(state.deadlineAt ?? now, now + STREAM_SMOOTH_WINDOW_MS),
      )
    : now + STREAM_SMOOTH_WINDOW_MS;
  return {
    target,
    displayed: state.displayed,
    animationStartedAt,
    deadlineAt,
  };
}

export function consumeStreamingTextFrame(
  state: StreamingTextState,
  now: number,
): StreamingTextState {
  if (state.displayed === state.target) {
    return state.animationStartedAt === undefined && state.deadlineAt === undefined
      ? state
      : createStreamingTextState(state.target);
  }
  if (!state.target.startsWith(state.displayed)) {
    return createStreamingTextState(state.target);
  }

  const remaining = Array.from(state.target.slice(state.displayed.length));
  const remainingMs = Math.max(0, (state.deadlineAt ?? now) - now);
  if (remainingMs <= ESTIMATED_FRAME_MS) {
    return createStreamingTextState(state.target);
  }
  const remainingFrames = Math.max(1, Math.ceil(remainingMs / ESTIMATED_FRAME_MS));
  const revealCount = Math.max(1, Math.ceil(remaining.length / remainingFrames));
  const displayed = `${state.displayed}${remaining.slice(0, revealCount).join("")}`;
  return displayed === state.target
    ? createStreamingTextState(state.target)
    : { ...state, displayed };
}

export function streamingTextHasPendingDisplay(state: StreamingTextState): boolean {
  return state.displayed !== state.target;
}

/**
 * 让流式输出过程中不完整的 Markdown 也能被安全渲染。
 * 仅闭合未配对的代码块围栏和常见 inline 标记，不修改已完整的内容。
 */
export function stabilizeStreamingMarkdown(value: string): string {
  let text = value.replace(/\r\n/g, "\n");

  // 未闭合的代码块围栏会在 ReactMarkdown 中吞掉后续内容，优先处理。
  const fenceCount = (text.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 === 1) {
    text += "\n```";
  }

  // 将文本按代码块切分，只在非代码块部分闭合 inline 标记。
  const parts = text.split(/^```/m);
  for (let index = 0; index < parts.length; index += 2) {
    parts[index] = stabilizeInlineMarkdown(parts[index]);
  }
  return parts.join("```");
}

export type StreamingMarkdownSegments = {
  readonly completedBlocks: readonly string[];
  readonly activeBlock: string;
};

export type StreamingMarkdownBlock = {
  /** 块在完整文本中的起始字符偏移，作为 React key 在流式推进时保持稳定。 */
  readonly start: number;
  readonly text: string;
};

export type StreamingMarkdownSegmentsWithOffsets = {
  readonly completedBlocks: readonly StreamingMarkdownBlock[];
  readonly activeBlock: string;
  readonly activeStart: number;
};

/**
 * A completed block cannot be changed by later append-only deltas, so its
 * Markdown tree can remain mounted while only the active tail is reparsed.
 */
export function splitStreamingMarkdown(value: string): StreamingMarkdownSegments {
  const segments = splitStreamingMarkdownWithOffsets(value);
  return {
    completedBlocks: segments.completedBlocks.map((block) => block.text),
    activeBlock: segments.activeBlock,
  };
}

export function splitStreamingMarkdownWithOffsets(value: string): StreamingMarkdownSegmentsWithOffsets {
  const text = value.replace(/\r\n/g, "\n");
  const completedBlocks: StreamingMarkdownBlock[] = [];
  let blockStart = 0;
  let lineStart = 0;
  let fenced = false;

  while (lineStart < text.length) {
    const lineEnd = text.indexOf("\n", lineStart);
    const end = lineEnd === -1 ? text.length : lineEnd + 1;
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    if (/^\s*```/u.test(line)) {
      fenced = !fenced;
    }
    if (!fenced && line.trim().length === 0 && end > blockStart) {
      const block = text.slice(blockStart, end);
      if (block.trim().length > 0) {
        completedBlocks.push({ start: blockStart, text: block });
      }
      blockStart = end;
    }
    lineStart = end;
  }

  return {
    completedBlocks,
    activeBlock: text.slice(blockStart),
    activeStart: blockStart,
  };
}

function stabilizeInlineMarkdown(value: string): string {
  let text = value;

  // 先闭合未配对的内联代码围栏，再把已闭合的代码段暂时抽离，
  // 避免代码内容内部的 * _ 等被误当成 markdown 标记。
  text = closeInlineMarker(text, "`");
  const codeSpans: string[] = [];
  text = text.replace(/`[^`]*`/g, (match) => {
    codeSpans.push(match);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  text = closeInlineMarker(text, "~~");
  text = closeInlineMarker(text, "**");
  text = closeInlineMarker(text, "__");
  text = closeSingleCharMarker(text, "*", "**");
  text = closeSingleCharMarker(text, "_", "__");

  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => codeSpans[Number(index)]);
}

function closeInlineMarker(text: string, marker: string): string {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const count = (text.match(new RegExp(escaped, "g")) ?? []).length;
  return count % 2 === 1 ? text + marker : text;
}

function closeSingleCharMarker(text: string, marker: string, pairMarker: string): string {
  const pairRegex = new RegExp(escapeRegex(pairMarker) + ".*?" + escapeRegex(pairMarker), "gs");
  const withoutPairs = text.replace(pairRegex, "");
  const count = (withoutPairs.match(new RegExp(escapeRegex(marker), "g")) ?? []).length;
  return count % 2 === 1 ? text + marker : text;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
