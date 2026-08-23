import type { SanitizedOrdinaryAgentPromptConfig } from "../../domain/config/index.js";
import type { AgentDefinition } from "./contracts.js";

// 根据 sanitized Ordinary Agent 配置组装运行时定义：内置提示词引用一致
// 直接复用 base 定义；中文变体与用户自定义提示词都按 config 携带的
// promptRef/promptVersion/systemPrompt 构建冻结定义，保证 run ref 语义一致。
export function ordinaryAgentDefinitionFromPromptConfig(
  baseDefinition: AgentDefinition,
  config: SanitizedOrdinaryAgentPromptConfig
): AgentDefinition {
  if (
    config.isDefault &&
    config.promptRef === baseDefinition.prompt.promptRef &&
    config.promptVersion === baseDefinition.prompt.version
  ) {
    return baseDefinition;
  }
  return {
    ...baseDefinition,
    prompt: {
      ...baseDefinition.prompt,
      promptRef: config.promptRef,
      version: config.promptVersion,
      systemPrompt: config.systemPrompt,
    },
  };
}
