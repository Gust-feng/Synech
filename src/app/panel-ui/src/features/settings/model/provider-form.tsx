import React, { useId } from "react";
import { Eye, EyeOff } from "lucide-react";
import { SettingsSelectControl } from "../components/select-control";
import type { ModelForm, ModelProviderListItem } from "./settings-projection";
import { modelProtocolKind, modelProtocolOptions } from "./settings-projection";
import { builtinProviderPresetId } from "./provider-logos";

/**
 * 模型服务表单组件属性定义。
 */
export type ModelProviderFormProps = {
  /** 当前选中的模型服务配置项信息（包含预设元数据、受保护状态等） */
  readonly item: ModelProviderListItem;
  /** 当前编辑中的表单草稿状态 */
  readonly modelForm: ModelForm;
  readonly piProviderIds: readonly string[];
  /** 当前 API Key 是否明文显式显示 */
  readonly revealed: boolean;
  /** 是否正在请求解密并显示 API Key */
  readonly revealBusy: boolean;
  /** 是否正在执行保存操作 */
  readonly saving?: boolean;
  /** 是否存在有效的 API Key 切换显示操作权限 */
  readonly hasApiKeyAction: boolean;
  /** 当前连接是否已在本地或安全存储中配置过密钥 */
  readonly selectedSecretConfigured: boolean;
  /** 表单草稿局部更新回调 */
  readonly onUpdateModelForm: (patch: Partial<ModelForm>) => void;
  /** 整体设置表单草稿回调 */
  readonly onSetModelForm: (form: ModelForm) => void;
  /** 触发解密显式显示 API Key 的异步回调 */
  readonly onRevealApiKey: () => Promise<void>;
  /** 调度并触发表单防抖自动持久化保存 */
  readonly onScheduleModelSave: (form: ModelForm) => void;
};

/**
 * 模型服务凭据与连接参数表单组件。
 *
 * 负责呈现与编辑 API Key（支持明文切换查看）、Base URL（节点基础连接地址）
 * 以及底层通信协议（Protocol / Transport，如 OpenAI 兼容、Anthropic Messages 等）。
 */
export function ModelProviderForm(props: ModelProviderFormProps): React.ReactElement {
  const piProviderListId = useId();
  const piProviderLocked = props.item.protectedBuiltin ||
    builtinProviderPresetId({ profileId: props.item.profileId }) !== undefined;
  const piProviderIds = [...new Set([
    ...props.piProviderIds,
    ...(props.item.preset?.piProviderIds ?? []),
    ...(props.item.piProviderId === undefined ? [] : [props.item.piProviderId]),
  ])].sort();

  return (
    <div className="provider-form">
      <label className="provider-form-full">
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
      <label className="provider-form-base-url">
        <span>Base URL</span>
        <div className="provider-base-url-field">
          <input
            value={props.modelForm.baseUrl}
            disabled={props.saving}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            title={props.modelForm.baseUrl || props.item.preset?.baseUrl || props.item.baseUrl || "https://api.example.com/v1"}
            onChange={(event) => {
              props.onUpdateModelForm({ baseUrl: event.target.value });
            }}
            onBlur={(event) => {
              event.currentTarget.scrollLeft = 0;
            }}
            placeholder={props.item.preset?.baseUrl || props.item.baseUrl || "https://api.example.com/v1"}
          />
        </div>
      </label>
      <div className="provider-protocol-field">
        <span>协议</span>
        <SettingsSelectControl
          id="provider-protocol-kind"
          ariaLabel="协议"
          value={props.modelForm.protocolKind || props.item.protocolKind}
          disabled={props.saving}
          options={modelProtocolOptions()}
          onChange={(value) => props.onUpdateModelForm({ protocolKind: modelProtocolKind(value) })}
        />
      </div>
      <label className="provider-form-full">
        <span>Pi Provider</span>
        <div className="provider-base-url-field">
          <input
            aria-label="Pi Provider"
            value={props.modelForm.piProviderId}
            list={piProviderListId}
            disabled={props.saving || piProviderLocked}
            title={piProviderLocked ? "内置槽位由预设管理" : undefined}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="未声明"
            onChange={(event) => props.onUpdateModelForm({ piProviderId: event.target.value })}
          />
          <datalist id={piProviderListId}>
            {piProviderIds.map((providerId) => <option key={providerId} value={providerId} />)}
          </datalist>
        </div>
      </label>
    </div>
  );
}
