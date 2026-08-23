export function modelRequestedSummary(payload: Readonly<Record<string, unknown>>): string | undefined {
  const explicit = visibleModelProgressSummary(
    stringOrUndefined(payload.summary) ??
    stringOrUndefined(payload.statusText) ??
    stringOrUndefined(payload.progressText)
  );
  if (explicit !== undefined) {
    return explicit;
  }
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function restoredModelRequestedSummary(summary: string): string | undefined {
  return visibleModelProgressSummary(summary);
}

export function visibleModelProgressSummary(value: string | undefined): string | undefined {
  const text = value?.trim() ?? "";
  if (text.length === 0 || isStaleModelProgressSummary(text)) {
    return undefined;
  }
  return text;
}

export function isStaleModelProgressSummary(value: string): boolean {
  const normalized = value.replace(/[。.!！?？；;:：、，,\s]/g, "");
  return normalized === "正在判断下一步" ||
    normalized === "等待模型输出" ||
    normalized === "正在组织直接回答" ||
    normalized === "等待模型路由结果";
}
