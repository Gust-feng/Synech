/**
 * 失败文案按结构化 `failureKind` 分支，不把 kernel/SDK 的英文消息当匹配键：
 * 结构字段负责程序分支，message 只负责展示（开发维护规则 §8）。
 */
export function friendlyFailureCopy(value: string): string {
  const text = value.trim();
  // OpenAI SDK 的无体错误（"429 status code (no body)"）是真实 provider 事实，
  // 压成 HTTP 状态码即可读，不作为任何程序分支的键。
  const sdkNoBody = /^(\d{3})\s+status code \(no body\)$/i.exec(text);
  if (sdkNoBody !== null) {
    return `HTTP ${sdkNoBody[1]}`;
  }
  return text;
}

export function friendlyModelFailureKindCopy(failureKind: string | undefined): string | undefined {
  switch (failureKind) {
    case "provider_auth":
      return "模型服务鉴权失败。";
    case "provider_rate_limit":
      return "模型服务限流。";
    case "provider_quota":
      return "模型服务额度不足，请检查账户套餐或充值。";
    case "provider_timeout":
      return "模型服务请求超时。";
    case "provider_network":
      return "模型服务连接失败。";
    case "provider_config":
      return "模型配置无效。";
    case "provider_response":
      return "模型服务响应无效。";
    case "content_filtered":
      return "模型输出被内容安全策略拦截。";
    case "output_truncated":
      return "模型输出达到长度上限被截断。";
    case "context_overflow":
      return "请求上下文超出模型窗口，请缩短输入或新建会话。";
    case "output_validation":
      return "模型输出校验失败。";
    case "request_validation":
      return "模型请求无效。";
    default:
      return undefined;
  }
}
