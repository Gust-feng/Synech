export type AssistantAnswerTone = "formal" | "process";

export type AssistantAnswerCandidate = {
  readonly text: string;
  readonly tone?: AssistantAnswerTone;
  readonly streaming?: boolean;
};

export type ResolvedAssistantAnswer = {
  readonly text: string;
  readonly source: "live" | "session" | "checkpoint" | "work_view" | "projection" | "none";
  readonly streaming: boolean;
  readonly tone?: AssistantAnswerTone;
};

export function resolveAssistantAnswer(input: {
  readonly runStatus?: string;
  readonly interruption?: "user_cancelled" | "runtime_stopped";
  readonly live?: AssistantAnswerCandidate;
  readonly conversationText?: string;
  readonly workViewText?: string;
  readonly projection?: AssistantAnswerCandidate;
}): ResolvedAssistantAnswer {
  const live = candidate(input.live);
  if (live !== undefined && live.streaming === true) {
    return resolved(live, "live", true);
  }

  const conversation = textCandidate(input.conversationText);
  const projection = candidate(input.projection);
  const workView = textCandidate(input.workViewText);

  if (input.runStatus === "completed") {
    if (conversation !== undefined) return resolved(conversation, "session", false);
    if (projection !== undefined) return resolved(projection, "projection", false);
    if (workView !== undefined) return resolved(workView, "work_view", false);
    return emptyAnswer();
  }

  if (input.interruption !== undefined) {
    if (conversation !== undefined) return resolved(conversation, "checkpoint", false);
    if (projection !== undefined) return resolved(projection, "projection", false);
    return emptyAnswer();
  }

  if (isNonAnswerTerminalStatus(input.runStatus)) return emptyAnswer();
  if (workView !== undefined) return resolved(workView, "work_view", false);
  if (projection !== undefined) return resolved(projection, "projection", projection.streaming === true);
  if (conversation !== undefined) return resolved(conversation, "session", false);
  return emptyAnswer();
}

export function isSettledPanelRunStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "blocked";
}

function isNonAnswerTerminalStatus(status: string | undefined): boolean {
  return status === "failed" || status === "cancelled" || status === "blocked";
}

function candidate(value: AssistantAnswerCandidate | undefined): AssistantAnswerCandidate | undefined {
  return value === undefined || value.text.trim().length === 0 ? undefined : value;
}

function textCandidate(text: string | undefined): AssistantAnswerCandidate | undefined {
  return text === undefined || text.trim().length === 0 ? undefined : { text };
}

function resolved(
  value: AssistantAnswerCandidate,
  source: Exclude<ResolvedAssistantAnswer["source"], "none">,
  streaming: boolean,
): ResolvedAssistantAnswer {
  return {
    text: value.text,
    source,
    streaming,
    ...(value.tone === undefined ? {} : { tone: value.tone }),
  };
}

function emptyAnswer(): ResolvedAssistantAnswer {
  return { text: "", source: "none", streaming: false };
}
