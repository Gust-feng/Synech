import React from "react";
import { Eye, EyeOff } from "lucide-react";
import type { ModelForm, ModelProviderListItem } from "./settings-projection";
import { modelProtocolKind, requestPathOptionsForProvider } from "./settings-projection";

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
      <label>
        <span>Pi Provider</span>
        <div className="provider-base-url-field">
          <input
            value={props.modelForm.piProviderId}
            disabled={props.saving === true || props.item.protectedBuiltin === true}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(event) => {
              props.onUpdateModelForm({ piProviderId: event.target.value });
            }}
            placeholder="模型语义来源，留空表示全部按未知模型处理"
          />
        </div>
        <small className="provider-field-hint">
          Pi Provider / 模型语义来源：与 Base URL 明确分离，声明该连接的已知模型取自哪个 Pi Provider 的真实目录。
        </small>
      </label>
      {props.item.preset === undefined && (
        <details className="provider-advanced-options">
          <summary>高级兼容设置</summary>
          <label>
            <span>默认传输</span>
            <select
              value={props.modelForm.protocolKind || props.item.protocolKind}
              aria-label="默认传输"
              onChange={(event) => props.onUpdateModelForm({ protocolKind: modelProtocolKind(event.target.value) })}
            >
              {requestPathOptionsForProvider().map((option) => (
                <option value={option.value} key={option.value}>{option.label}</option>
              ))}
            </select>
            <small className="provider-field-hint">
              连接级默认 transport：已知模型的 transport 由 Pi 事实决定，这里只用于远程发现但 Pi 未识别的模型。
            </small>
          </label>
        </details>
      )}
    </div>
  );
}
