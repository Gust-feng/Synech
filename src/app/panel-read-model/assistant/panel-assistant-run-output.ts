import { friendlyUserFacingFailureText } from "../../text-projection/visible-text-safety.js";

export type AssistantRunLike = {
  readonly status: string;
};

export type AssistantWorkViewProblemLike = {
  readonly headline?: string;
  readonly currentAction?: string;
};

export type AssistantRunDetailLike = {
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
  readonly restoredResult?: {
    readonly summary: string;
    readonly content?: string;
  };
};

export type AssistantRunProblem = {
  readonly title?: string;
  readonly message: string;
  readonly tone: "warning" | "error";
};

export function visibleRunProblem(
  run: AssistantRunLike | undefined,
  workView: AssistantWorkViewProblemLike | undefined,
  detail: AssistantRunDetailLike | undefined,
  error: string | undefined
): AssistantRunProblem | undefined {
  if (error !== undefined) {
    return { title: "出现错误", message: readableAppError(error), tone: "error" };
  }
  if (detail?.error?.code === "execution_continuation_lost" ||
      detail?.error?.code === "confirmation_continuation_lost") {
    return undefined;
  }
  if (run?.status === "blocked" || run?.status === "paused") {
    return {
      title: workView?.headline ?? "任务没有完成",
      message: visibleBlockedMessage(detail?.error?.message) ?? visibleProblemText(workView?.currentAction) ?? "任务没有完成。",
      tone: "warning",
    };
  }
  if (run?.status === "failed") {
    return {
      message: visibleProblemText(detail?.error?.message) ?? visibleProblemText(workView?.currentAction) ?? "没有返回可用结果。",
      tone: "error",
    };
  }
  return undefined;
}

export function visibleResultText(detail: AssistantRunDetailLike | undefined): string | undefined {
  return (
    nonEmptyText(detail?.restoredResult?.content) ??
    detail?.restoredResult?.summary
  );
}

function readableAppError(error: string): string {
  const message = error.replace(/^系统错误[:：]\s*/, "").trim();
  return message.length === 0 ? "发生了错误，但没有返回详情。" : friendlyUserFacingFailureText(message);
}

function visibleBlockedMessage(message: string | undefined): string | undefined {
  // 如实透传 blocked 原因，不能用固定文案掩盖运行事实。
  return visibleProblemText(message);
}

function visibleProblemText(message: string | undefined): string | undefined {
  return message === undefined || message.trim().length === 0
    ? undefined
    : friendlyUserFacingFailureText(message);
}

function nonEmptyText(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}
