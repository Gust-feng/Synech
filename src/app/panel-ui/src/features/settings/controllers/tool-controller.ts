import type React from "react";
import {
  refreshSkillCatalog,
  refreshSubAgentCatalog,
  resetOrdinaryAgentSystemPrompt as requestResetOrdinaryAgentSystemPrompt,
  saveCommandShellConfig,
  saveOrdinaryAgentSystemPrompt as requestSaveOrdinaryAgentSystemPrompt,
  saveOrdinaryAgentSystemPromptVariant as requestSaveOrdinaryAgentSystemPromptVariant,
  saveSkillTriggerConfig,
  saveToolConfirmationConfig,
  saveToolSettings,
  updateSkillState,
} from "../config-actions";
import {
  mergeConfigResponse,
  type ComposerToolConfirmationPolicy,
} from "../config-projection";
import type { ToolForm } from "../components/types";
import type { CommandShellKind, SkillTriggerMode } from "../../../../../panel-api/config";
import type { SkillDefinition } from "../../../contracts/skills";
import type { SettingsControllerContext } from "./controller-types";

export type ToolSettingsController = {
  readonly saveCommandShell: (kind: CommandShellKind | "auto") => Promise<void>;
  readonly saveToolConfirmationPolicy: (policy: ComposerToolConfirmationPolicy) => Promise<void>;
  readonly saveOrdinaryAgentSystemPrompt: (systemPrompt: string) => Promise<void>;
  readonly saveOrdinaryAgentSystemPromptVariant: (variant: string) => Promise<void>;
  readonly resetOrdinaryAgentSystemPrompt: () => Promise<void>;
  readonly saveSkillTriggerMode: (mode: SkillTriggerMode) => Promise<void>;
  readonly saveTools: (nextToolForm?: ToolForm) => Promise<void>;
  readonly refreshSkills: () => Promise<void>;
  readonly refreshSubAgents: () => Promise<void>;
  readonly updateSkill: (skill: Pick<SkillDefinition, "id" | "stateKey">, enabled: boolean) => Promise<void>;
};

export type ToolSettingsControllerOptions = SettingsControllerContext & {
  readonly setOrdinaryAgentSystemPrompt: React.Dispatch<React.SetStateAction<string>>;
  readonly toolForm: ToolForm;
  readonly setToolForm: React.Dispatch<React.SetStateAction<ToolForm>>;
  readonly toolSaveQueueRef: React.MutableRefObject<Promise<void>>;
  readonly setSavingEnvironment: React.Dispatch<React.SetStateAction<boolean>>;
  readonly setSavingOrdinaryAgentPrompt: React.Dispatch<React.SetStateAction<boolean>>;
  readonly setSavingTools: React.Dispatch<React.SetStateAction<boolean>>;
};

export function createToolSettingsController(options: ToolSettingsControllerOptions): ToolSettingsController {
  async function saveCommandShell(kind: CommandShellKind | "auto"): Promise<void> {
    options.setSavingEnvironment(true);
    try {
      const response = await saveCommandShellConfig(kind);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          config: mergeConfigResponse(previous.config, response),
        }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "命令 shell 保存失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingEnvironment(false);
    }
  }

  async function saveToolConfirmationPolicy(policy: ComposerToolConfirmationPolicy): Promise<void> {
    try {
      const response = await saveToolConfirmationConfig(policy);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          config: mergeConfigResponse(previous.config, response),
          error: undefined,
        }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "确认策略保存失败。",
        }));
      }
      throw error;
    }
  }

  async function saveOrdinaryAgentSystemPrompt(systemPrompt: string): Promise<void> {
    options.setSavingOrdinaryAgentPrompt(true);
    try {
      const response = await requestSaveOrdinaryAgentSystemPrompt(systemPrompt);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          config: mergeConfigResponse(previous.config, response),
          error: undefined,
        }));
        options.setOrdinaryAgentSystemPrompt(response.ordinaryAgent?.systemPrompt ?? systemPrompt);
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "系统提示词保存失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingOrdinaryAgentPrompt(false);
    }
  }

  async function saveOrdinaryAgentSystemPromptVariant(variant: string): Promise<void> {
    options.setSavingOrdinaryAgentPrompt(true);
    try {
      const response = await requestSaveOrdinaryAgentSystemPromptVariant(variant);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          config: mergeConfigResponse(previous.config, response),
          error: undefined,
        }));
        options.setOrdinaryAgentSystemPrompt(response.ordinaryAgent?.systemPrompt ?? "");
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "提示词偏好保存失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingOrdinaryAgentPrompt(false);
    }
  }

  async function resetOrdinaryAgentSystemPrompt(): Promise<void> {
    options.setSavingOrdinaryAgentPrompt(true);
    try {
      const response = await requestResetOrdinaryAgentSystemPrompt();
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          config: mergeConfigResponse(previous.config, response),
          error: undefined,
        }));
        options.setOrdinaryAgentSystemPrompt(response.ordinaryAgent?.systemPrompt ?? "");
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "系统提示词恢复失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingOrdinaryAgentPrompt(false);
    }
  }

  async function saveSkillTriggerMode(mode: SkillTriggerMode): Promise<void> {
    options.setSavingTools(true);
    try {
      const response = await saveSkillTriggerConfig(mode);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          config: mergeConfigResponse(previous.config, response),
          error: undefined,
        }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "Skills 触发方式保存失败。",
        }));
      }
      throw error;
    } finally {
      if (options.mountedRef.current) options.setSavingTools(false);
    }
  }

  async function saveTools(nextToolForm: ToolForm = options.toolForm): Promise<void> {
    const save = options.toolSaveQueueRef.current
      .catch(() => undefined)
      .then(() => persistTools(nextToolForm));
    options.toolSaveQueueRef.current = save.catch(() => undefined);
    await save;
  }

  async function persistTools(nextToolForm: ToolForm): Promise<void> {
    options.setSavingTools(true);
    try {
      const response = await saveToolSettings(nextToolForm);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          tools: {
            ...response,
            mcpCatalog: response.mcpCatalog ?? previous.tools?.mcpCatalog,
          },
        }));
        if (nextToolForm.apiKey.trim().length > 0) {
          options.setToolForm((previous) => ({ ...previous, apiKey: "" }));
        }
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "工具配置保存失败。",
        }));
      }
    } finally {
      if (options.mountedRef.current) options.setSavingTools(false);
    }
  }

  async function updateSkill(skill: Pick<SkillDefinition, "id" | "stateKey">, enabled: boolean): Promise<void> {
    options.setSavingTools(true);
    try {
      const skills = await updateSkillState(skill, enabled);
      if (options.mountedRef.current) {
        options.setApp((previous) => ({ ...previous, skills, error: undefined }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "技能状态保存失败。",
        }));
      }
    } finally {
      if (options.mountedRef.current) options.setSavingTools(false);
    }
  }

  async function refreshSkills(): Promise<void> {
    options.setSavingTools(true);
    try {
      const skills = await refreshSkillCatalog();
      if (options.mountedRef.current) {
        options.setApp((previous) => ({ ...previous, skills, error: undefined }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "技能刷新失败。",
        }));
      }
    } finally {
      if (options.mountedRef.current) options.setSavingTools(false);
    }
  }

  async function refreshSubAgents(): Promise<void> {
    options.setSavingTools(true);
    try {
      const subAgents = await refreshSubAgentCatalog();
      if (options.mountedRef.current) {
        options.setApp((previous) => ({ ...previous, subAgents, error: undefined }));
      }
    } catch (error) {
      if (options.mountedRef.current) {
        options.setApp((previous) => ({
          ...previous,
          error: error instanceof Error ? error.message : "子 Agent 刷新失败。",
        }));
      }
    } finally {
      if (options.mountedRef.current) options.setSavingTools(false);
    }
  }

  return {
    saveCommandShell,
    saveToolConfirmationPolicy,
    saveOrdinaryAgentSystemPrompt,
    saveOrdinaryAgentSystemPromptVariant,
    resetOrdinaryAgentSystemPrompt,
    saveSkillTriggerMode,
    saveTools,
    refreshSkills,
    refreshSubAgents,
    updateSkill,
  };
}
