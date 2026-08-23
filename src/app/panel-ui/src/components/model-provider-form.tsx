import React from "react";
import { Eye, EyeOff } from "lucide-react";
import type { ModelForm, ModelProviderListItem } from "./model-settings-projection";
import { modelProtocolKind, requestPathOptionsForProvider } from "./model-settings-projection";

export function ModelProviderForm(props: {
  readonly item: ModelProviderListItem;
  readonly modelForm: ModelForm;
  readonly revealed: boolean;
  readonly revealBusy: boolean;
  readonly saving?: boolean;
  readonly hasApiKeyAction: boolean;
  readonly selectedSecretConfigured: boolean;
  readonly onUpdateModelForm: (patch: Partial<ModelForm>) => void;
  readonly onSetModelForm: (form: ModelForm) => void;
  readonly onRevealApiKey: () => Promise<void>;
  readonly onScheduleModelSave: (form: ModelForm) => void;
}): React.ReactElement {
  return (
    <div className="provider-form">
      <label>
        <span>API Key</span>
        <div className="api-key-field">
          <input
            type={props.revealed ? "text" : "password"}
            className={props.revealed ? undefined : "api-key-input-masked"}
            value={props.modelForm.apiKey}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              const nextApiKey = event.target.value;
              const nextForm = {
                ...props.modelForm,
                apiKey: nextApiKey,
                apiKeyCleared: nextApiKey.length === 0 && props.selectedSecretConfigured,
              };
              props.onSetModelForm(nextForm);
              props.onScheduleModelSave(nextForm);
            }}
            placeholder={props.selectedSecretConfigured ? "••••••••••••••••" : "请输入密钥"}
          />
          <span className="api-key-actions">
            <button
              type="button"
              className="api-key-action"
              aria-label={props.revealed ? "隐藏 API Key" : "查看 API Key"}
              disabled={!props.hasApiKeyAction || props.revealBusy || props.saving}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => void props.onRevealApiKey()}
            >
              {props.revealed ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </span>
        </div>
      </label>
      <label>
        <span>Base URL</span>
        <div className="provider-base-url-field">
          <input
            value={props.modelForm.baseUrl || props.item.baseUrl}
            disabled={props.saving}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(event) => {
              props.onUpdateModelForm({ baseUrl: event.target.value });
            }}
            placeholder="https://api.example.com/v1"
          />
        </div>
      </label>
      {props.item.preset === undefined && (
        <details className="provider-advanced-options">
          <summary>高级兼容设置</summary>
          <label>
            <span>协议</span>
            <select
              value={props.modelForm.protocolKind || props.item.protocolKind}
              aria-label="协议"
              onChange={(event) => props.onUpdateModelForm({ protocolKind: modelProtocolKind(event.target.value) })}
            >
              {requestPathOptionsForProvider().map((option) => (
                <option value={option.value} key={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </details>
      )}
    </div>
  );
}