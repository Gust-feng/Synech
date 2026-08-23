import type { AgentDefinition } from "./contracts.js";
import { ORDINARY_AGENT_ID } from "./ordinary-agent-identity.js";
import { ORDINARY_AGENT_OUTPUT_CONTRACT } from "./ordinary-agent-output-contract.js";
import {
  ORDINARY_AGENT_PROMPT,
  ORDINARY_AGENT_PROMPT_ZH,
} from "./ordinary-agent-prompt.js";
import { ORDINARY_AGENT_TOOL_VISIBILITY } from "./ordinary-agent-tool-visibility.js";
import { ORDINARY_AGENT_TURN_POLICY } from "./ordinary-agent-turn-policy.js";

export const ORDINARY_AGENT: AgentDefinition = {
  agentId: ORDINARY_AGENT_ID,
  displayName: "Ordinary Agent",
  prompt: ORDINARY_AGENT_PROMPT,
  turnPolicy: ORDINARY_AGENT_TURN_POLICY,
  outputContract: ORDINARY_AGENT_OUTPUT_CONTRACT,
  toolVisibilityProfile: ORDINARY_AGENT_TOOL_VISIBILITY,
};

// 简体中文提示词变体定义：供运行时目录解析 zh-v1 引用与恢复历史 run。
export const ORDINARY_AGENT_ZH: AgentDefinition = {
  ...ORDINARY_AGENT,
  prompt: ORDINARY_AGENT_PROMPT_ZH,
};
