// 桌面根 Agent 内置提示词偏好：决定 built_in 状态下使用哪个内置提示词版本。
// "en" 使用当前英文内置提示词（跟随英文默认提示词线，新英文版本自动生效）；
// 具体变体（如 "zh-v1"）固定使用对应冻结内置提示词。自定义提示词
// （systemPromptMode="custom"）生效时，该偏好只作为恢复默认后的潜在选择，
// 不改变实际提示词。
export type OrdinaryAgentPromptVariant = "en" | "zh-v1";

export type OrdinaryAgentPromptVariantInfo = {
  readonly id: OrdinaryAgentPromptVariant;
  readonly label: string;
  readonly description: string;
};
export type OrdinaryAgentPromptSettings =
  | {
      readonly systemPromptMode: "built_in";
      readonly systemPromptVariant: OrdinaryAgentPromptVariant;
      readonly updatedAt: string;
    }
  | {
      readonly systemPromptMode: "custom";
      readonly systemPrompt: string;
      readonly systemPromptVariant: OrdinaryAgentPromptVariant;
      readonly updatedAt: string;
    };

export type SkillTriggerMode = "keyword" | "model";

export type SkillTriggerSettings = {
  readonly mode: SkillTriggerMode;
  readonly updatedAt: string;
};

export type SanitizedOrdinaryAgentPromptConfig = {
  readonly systemPrompt: string;
  // 解析后的内置提示词偏好；custom 状态下保留为潜在偏好。
  readonly systemPromptVariant: OrdinaryAgentPromptVariant;
  // 当前实际生效提示词的稳定身份，供 AgentDefinition 组装与 run ref 使用。
  readonly promptRef: string;
  readonly promptVersion: string;
  readonly updatedAt: string;
  readonly isDefault: boolean;
  readonly maxSystemPromptChars: number;
  readonly variants: readonly OrdinaryAgentPromptVariantInfo[];
};

export type UpdateOrdinaryAgentPromptConfigInput = {
  readonly systemPrompt?: string;
  readonly resetSystemPrompt?: boolean;
  readonly systemPromptVariant?: OrdinaryAgentPromptVariant;
};

export type SanitizedSkillTriggerConfig = {
  readonly mode: SkillTriggerMode;
  readonly label: string;
  readonly modelRouterEnabled: boolean;
  readonly summary: string;
  readonly updatedAt: string;
};

export type UpdateSkillTriggerConfigInput = {
  readonly mode: SkillTriggerMode;
};
