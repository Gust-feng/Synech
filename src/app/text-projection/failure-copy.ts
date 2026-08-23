export function friendlyFailureCopy(value: string): string {
  const text = value.trim();
  if (/^Model output failed the requested output contract\.$/i.test(text)) {
    return "模型输出校验失败。";
  }
  if (/^Ordinary Agent model stopped without a visible answer\.$/i.test(text)) {
    return "没有返回可用结果。";
  }
  const sdkNoBody = /^(\d{3})\s+status code \(no body\)$/i.exec(text);
  if (sdkNoBody !== null) {
    return `HTTP ${sdkNoBody[1]}`;
  }
  if (/openai-compatible provider stream response could not be parsed/i.test(text)) {
    return "模型服务的流式返回格式不兼容，已改用非流式方式重试；如果仍失败，请在设置中关闭该模型的流式输出。";
  }
  return text;
}

export function friendlyModelFailureKindCopy(failureKind: string | undefined): string | undefined {
  switch (failureKind) {
    case "provider_auth":
      return "模型服务鉴权失败。";
    case "provider_rate_limit":
      return "模型服务限流。";
    case "provider_timeout":
      return "模型服务请求超时。";
    case "provider_network":
      return "模型服务连接失败。";
    case "output_validation":
      return "模型输出校验失败。";
    case "request_validation":
      return "模型请求无效。";
    case "provider_config":
      return "模型配置无效。";
    case "provider_response":
      return "模型服务响应无效。";
    case "model_failed":
      return "没有返回可用结果。";
    default:
      return undefined;
  }
}
