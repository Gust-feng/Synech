import React, { useRef, useState } from "react";
import { ArrowLeft, RotateCcw, Save } from "lucide-react";
import type { ModelCapabilities, ModelConfiguration } from "@panel-api/config";
import { SettingsSelectControl } from "../components/select-control";
import {
  isConfirmedModelFacts,
  MODEL_REASONING_LEVEL_OPTIONS,
  modelContextWindowTokens,
  modelMaxOutputTokens,
  modelSupportsReasoningOutput,
  modelSupportsVisionInput,
  runReasoningEffortOptions,
} from "./capability-display";
import { modelConfigurationDraft, modelConfigurationFromDraft } from "./model-configuration-form";
import type { ModelProviderModelItem } from "./settings-projection";
import "./model-capability-editor.css";

export function ModelCapabilityEditor(props: {
  readonly profileLabel: string;
  readonly model: ModelProviderModelItem;
  readonly configuration?: ModelConfiguration;
  readonly capabilities?: ModelCapabilities;
  readonly onClose: () => void;
  readonly onSave: (settings: ModelConfiguration | null) => Promise<void>;
}): React.ReactElement {
  const inheritedCapabilities = props.capabilities?.facts === undefined ? undefined : { facts: props.capabilities.facts };
  const [draft, setDraft] = useState(() => modelConfigurationDraft(props.configuration, inheritedCapabilities));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submissionRef = useRef(false);
  const reasoningDisabled = modelSupportsReasoningOutput({
    ...inheritedCapabilities,
    configuration: { overrides: {
      supportsReasoningOutput: draft.supportsReasoningOutput,
      thinkingLevels: draft.thinkingLevels,
    } },
  }) === false;
  const inheritedLevels = runReasoningEffortOptions(inheritedCapabilities).map((option) => option.value);
  const displayedLevels = draft.thinkingLevels ?? inheritedLevels;

  async function persist(reset: boolean): Promise<void> {
    if (submissionRef.current) return;
    submissionRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const settings = reset ? null : modelConfigurationFromDraft(draft, inheritedCapabilities);
      await props.onSave(settings);
      setDraft(modelConfigurationDraft(settings ?? undefined, inheritedCapabilities));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模型能力设置保存失败。");
    } finally {
      submissionRef.current = false;
      setBusy(false);
    }
  }

  return (
    <section
      className="provider-detail-pane model-capability-editor"
      aria-label={`模型能力设置 ${props.model.id}`}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        if (!busy && !(event.target as HTMLElement).closest(".settings-select-control.open")) props.onClose();
      }}
    >
      <header className="model-picker-header">
        <div className="model-picker-header-start">
          <button type="button" className="model-picker-back-btn" onClick={props.onClose} disabled={busy} title="返回模型列表" aria-label="返回模型列表" autoFocus>
            <ArrowLeft size={16} />
          </button>
          <div className="model-picker-header-text">
            <h2>{props.model.displayName || props.model.id}</h2>
            <p>{props.profileLabel} · {props.model.id}</p>
          </div>
        </div>
      </header>
      <p className="model-capability-source">
        {isConfirmedModelFacts(props.capabilities?.facts)
          ? "已自动匹配模型能力；可在下方调整。"
          : "未匹配到模型能力，上下文默认 256K；可在下方手动配置。"}
      </p>
      <form onSubmit={(event) => { event.preventDefault(); void persist(false); }}>
        <div className="provider-form model-capability-fields">
          <label>
            <span>上下文窗口 (tokens)</span>
            <input
              type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} disabled={busy}
              value={draft.contextWindowTokens}
              placeholder={inheritedNumberLabel(modelContextWindowTokens(inheritedCapabilities))}
              onChange={(event) => setDraft((previous) => ({ ...previous, contextWindowTokens: event.target.value }))}
            />
          </label>
          <label>
            <span>最大输出 (tokens)</span>
            <input
              type="number" min={1} max={Number.MAX_SAFE_INTEGER} step={1} disabled={busy}
              value={draft.maxOutputTokens}
              placeholder={inheritedNumberLabel(modelMaxOutputTokens(inheritedCapabilities))}
              onChange={(event) => setDraft((previous) => ({ ...previous, maxOutputTokens: event.target.value }))}
            />
          </label>
          <div className="provider-protocol-field">
            <span>视觉输入</span>
            <SettingsSelectControl
              id="model-capability-vision" ariaLabel="视觉输入" disabled={busy}
              value={booleanSelection(draft.supportsVisionInput)}
              options={booleanOptions(modelSupportsVisionInput(inheritedCapabilities))}
              onChange={(value) => setDraft((previous) => ({ ...previous, supportsVisionInput: selectedBoolean(value) }))}
            />
          </div>
          <div className="provider-protocol-field">
            <span>推理输出</span>
            <SettingsSelectControl
              id="model-capability-reasoning" ariaLabel="推理输出" disabled={busy}
              value={booleanSelection(draft.supportsReasoningOutput)}
              options={booleanOptions(modelSupportsReasoningOutput(inheritedCapabilities))}
              onChange={(value) => setDraft((previous) => ({ ...previous, supportsReasoningOutput: selectedBoolean(value) }))}
            />
          </div>
        </div>
        <fieldset className="model-capability-levels" disabled={busy || reasoningDisabled}>
          <legend>推理档位</legend>
          <label className="model-capability-checkbox">
            <input
              type="checkbox"
              checked={draft.thinkingLevels === undefined}
              onChange={(event) => {
                const inherit = event.target.checked;
                setDraft((previous) => ({ ...previous, thinkingLevels: inherit ? undefined : inheritedLevels }));
              }}
            />
            <span>自动</span>
          </label>
          <div className="model-capability-level-options">
            {MODEL_REASONING_LEVEL_OPTIONS.map((option) => (
              <label key={option.value} className="model-capability-checkbox">
                <input
                  type="checkbox"
                  checked={displayedLevels.includes(option.value)}
                  disabled={draft.thinkingLevels === undefined}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setDraft((previous) => ({
                      ...previous,
                      thinkingLevels: MODEL_REASONING_LEVEL_OPTIONS
                        .filter((candidate) => candidate.value === option.value ? checked : previous.thinkingLevels?.includes(candidate.value))
                        .map((candidate) => candidate.value),
                    }));
                  }}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error !== undefined && <p className="model-capability-error" role="alert">{error}</p>}
        <footer className="model-picker-footer">
          <button type="button" className="model-picker-cancel-btn" disabled={busy} onClick={() => void persist(true)}>
            <RotateCcw size={14} /> 恢复默认
          </button>
          <button type="submit" className="model-picker-confirm-btn" disabled={busy}>
            <Save size={14} /> {busy ? "保存中" : "保存"}
          </button>
        </footer>
      </form>
    </section>
  );
}

function inheritedNumberLabel(value: number | undefined): string {
  return value === undefined ? "自动" : `自动 · ${value}`;
}

function booleanSelection(value: boolean | undefined): string {
  return value === undefined ? "auto" : value ? "yes" : "no";
}

function selectedBoolean(value: string): boolean | undefined {
  return value === "yes" ? true : value === "no" ? false : undefined;
}

function booleanOptions(inherited: boolean | undefined): readonly { readonly value: string; readonly label: string }[] {
  return [
    { value: "auto", label: inherited === undefined ? "自动" : inherited ? "自动（支持）" : "自动（不支持）" },
    { value: "yes", label: "支持" },
    { value: "no", label: "不支持" },
  ];
}
