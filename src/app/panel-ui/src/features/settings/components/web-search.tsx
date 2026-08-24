import React from "react";
import { Globe } from "lucide-react";
import type { ToolsResponse } from "@panel-api/tools";
import type { ToolForm } from "./types";
import { SettingsSelectControl } from "./select-control";
import { CapabilitySettingsSection } from "./capability-section";

const SAVED_API_KEY_MASK = "****************";

export function WebSearchSettings(props: {
  readonly tools?: ToolsResponse;
  readonly toolForm: ToolForm;
  readonly setToolForm: (form: ToolForm) => void;
  readonly saving?: boolean;
  readonly onSaveTools: (form: ToolForm) => void;
}): React.ReactElement {
  const provider = props.toolForm.provider;
  const configured =
    props.tools?.tools?.webSearch?.secretConfigured === true &&
    props.tools.tools.webSearch.provider === provider;
  const externalProvider = provider !== "model_builtin";
  const updateForm = (form: ToolForm, options: { readonly save?: boolean } = { save: true }): void => {
    props.setToolForm(form);
    if (options.save !== false) {
      props.onSaveTools(form);
    }
  };
  const saveSecretOnCommit = (apiKey: string): void => {
    if (apiKey.trim().length === 0) {
      return;
    }
    props.onSaveTools({ ...props.toolForm, apiKey });
  };
  return (
    <CapabilitySettingsSection
      icon={<Globe size={16} />}
      title="网络搜索"
      busy={props.saving === true}
    >
      <div className="service-config-grid web-search-config-grid">
        <label>
          搜索服务
          <SettingsSelectControl
            id="web-search-provider"
            ariaLabel="搜索服务"
            value={props.toolForm.provider}
            options={[
              { value: "tavily", label: "Tavily" },
              { value: "exa", label: "Exa" },
              { value: "zai", label: "Z.AI" },
              { value: "metaso", label: "秘塔搜索" },
              { value: "google", label: "Google" },
              { value: "bing", label: "Bing" },
              { value: "model_builtin", label: "模型内置" },
            ]}
            onChange={(value) => updateForm({ ...props.toolForm, provider: value, apiKey: "" })}
          />
        </label>
        {externalProvider && (
          <label>
            {webSearchApiKeyLabel(provider)}
            <input
              type="password"
              value={props.toolForm.apiKey}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              onBlur={(event) => saveSecretOnCommit(event.currentTarget.value)}
              onChange={(event) => updateForm({ ...props.toolForm, apiKey: event.target.value }, { save: false })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              placeholder={configured ? SAVED_API_KEY_MASK : "请输入密钥"}
            />
          </label>
        )}
        {externalProvider && provider === "google" && (
          <label>
            Engine ID
            <input
              type="text"
              value={props.toolForm.engineId}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              onChange={(event) => updateForm({ ...props.toolForm, engineId: event.target.value })}
              placeholder="cx"
            />
          </label>
        )}
        {externalProvider && (
          <label className="web-search-max-results">
            结果数
            <input
              type="number"
              min={1}
              max={webSearchMaxResults(provider)}
              value={props.toolForm.maxResults}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              onChange={(event) => updateForm({ ...props.toolForm, maxResults: event.target.value })}
            />
          </label>
        )}
      </div>
    </CapabilitySettingsSection>
  );
}

function webSearchApiKeyLabel(provider: string): string {
  if (provider === "exa") return "Exa Key";
  if (provider === "zai") return "Z.AI Key";
  if (provider === "metaso") return "秘塔 Key";
  if (provider === "google") return "Google Key";
  if (provider === "bing") return "Bing Key";
  return "Tavily Key";
}

function webSearchMaxResults(provider: string): number {
  if (provider === "google") return 10;
  if (provider === "tavily") return 20;
  if (provider === "exa") return 100;
  return 50;
}
