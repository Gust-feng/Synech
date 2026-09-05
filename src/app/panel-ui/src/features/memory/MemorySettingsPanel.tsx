import { useCallback, useEffect, useState } from "react";
import {
  clearImplicitMemory,
  fetchMemoryCapability,
  fetchSpaceMemoryView,
  writeSpaceMemory,
  setMemoryConsent,
  setMemorySpaceParticipation,
  type MemoryCapabilityStatus,
  type SpaceMemoryView,
} from "@panel-api/memory-admin";
import "./memory.css";

export type MemorySettingsOwner =
  | { readonly kind: "space"; readonly id: string }
  | { readonly kind: "workspace"; readonly id: string };

export type MemorySettingsScope = {
  readonly owner?: MemorySettingsOwner;
};

type MemoryScope = { readonly kind: "global" } | Extract<MemorySettingsOwner, { readonly kind: "space" }>;

const STATUS_LABEL = {
  off: "未启用",
  shadow: "实验验证中（不会影响回答）",
  active: "已开启并正在使用",
} as const;

const HEALTH_LABEL = {
  ready: "就绪",
  degraded: "降级（继续对话，本次可能不会使用长期记忆）",
  unavailable: "暂时不可用",
} as const;

function statusText(status: MemoryCapabilityStatus, scope: MemorySettingsScope | null): string {
  if (status.health !== "ready") return HEALTH_LABEL[status.health];
  if (status.rollout === "off") return STATUS_LABEL.off;
  if (status.rollout === "shadow") return STATUS_LABEL.shadow;
  if (scope?.owner?.kind === "workspace") return "仅 Space 可用";
  if (scope === null && status.globalConsent) return "等待在 Space 中启用";
  if (status.effective === "active") return STATUS_LABEL.active;
  if (status.effective === "off") return STATUS_LABEL.off;
  return STATUS_LABEL.shadow;
}

function describeHelp(scope: MemorySettingsScope | null): string {
  if (scope === null) {
    return "先启用全局开关，再进入 Space 对话为该 Space 单独开启；后台整理可能产生少量模型服务 API 用量。自动记忆不会修改协作规则和路径依赖。";
  }
  if (scope.owner?.kind === "workspace") {
    return "自动记忆只在 Space 中启用；当前工作区的对话不会读取或写入。";
  }
  return "关闭期间的内容不会在重新开启后补记。";
}

export type MemorySettingsPanelProps = {
  readonly scope: MemorySettingsScope | null;
  readonly onAfterChange?: () => void;
};

export function MemorySettingsPanel(props: MemorySettingsPanelProps) {
  const [status, setStatus] = useState<MemoryCapabilityStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clearScope, setClearScope] = useState<MemoryScope | null>(null);
  const ownerKind = props.scope?.owner?.kind;
  const ownerId = props.scope?.owner?.id;
  const currentSpaceScope = props.scope?.owner?.kind === "space" ? props.scope.owner : undefined;

  const refresh = useCallback(async () => {
    try {
      const response = await fetchMemoryCapability({
        ...(ownerKind === undefined || ownerId === undefined ? {} : {
          owner: { kind: ownerKind, id: ownerId },
        }),
      });
      setStatus(response.status);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取记忆状态");
    }
  }, [ownerId, ownerKind]);

  useEffect(() => {
    setStatus(null);
    setClearScope(null);
    void refresh();
  }, [refresh]);

  const onAfterChange = props.onAfterChange;
  const runMutation = useCallback(async (operation: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
      onAfterChange?.();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }, [onAfterChange, refresh]);

  if (status === null) {
    return (
      <section className="memory-settings" aria-busy>
        <p>{error ?? "正在加载..."}</p>
      </section>
    );
  }

  return (
    <section className="memory-settings">
      <fieldset disabled={busy}>
        <label>
          <input
            type="checkbox"
            checked={status.globalConsent}
            onChange={(event) => runMutation(() => setMemoryConsent({ globalConsent: event.target.checked }))}
          />
          启用自动记忆（全局）
        </label>
        {props.scope?.owner?.kind === "space" && (
          <SpaceParticipationControl
            spaceId={props.scope.owner.id}
            enabled={status.spaceParticipation === true}
            disabled={!status.globalConsent}
            runMutation={runMutation}
          />
        )}
        {props.scope?.owner?.kind === "space" && !status.globalConsent && (
          <p className="memory-hint">全局关闭；重新开启后，此 Space 会恢复当前参与设置。</p>
        )}
        {props.scope?.owner?.kind === "space" && (
          <SpaceMemoryEditor spaceId={props.scope.owner.id} runMutation={runMutation} />
        )}
        {clearScope !== null ? (
          <ConfirmClear
            scope={clearScope}
            onCancel={() => setClearScope(null)}
            onConfirm={async () => {
              const completed = await runMutation(async () => {
                await clearImplicitMemory({ scope: clearScope });
              });
              if (completed) setClearScope(null);
            }}
          />
        ) : (
          <>
            {currentSpaceScope !== undefined && (
              <button
                type="button"
                className="memory-clear"
                onClick={() => setClearScope(currentSpaceScope)}
              >
                清除此 Space 的自动记忆
              </button>
            )}
            {(props.scope === null || currentSpaceScope !== undefined) && (
              <button
                type="button"
                className="memory-clear"
                onClick={() => setClearScope({ kind: "global" })}
              >
                清除全部自动记忆
              </button>
            )}
          </>
        )}
      </fieldset>
      {error !== null && <p className="memory-error" role="alert">{error}</p>}
      <p className="memory-status">状态：{statusText(status, props.scope)}</p>
      <p className="memory-help">{describeHelp(props.scope)}</p>
    </section>
  );
}

function SpaceParticipationControl(props: {
  readonly spaceId: string;
  readonly enabled: boolean;
  readonly disabled: boolean;
  readonly runMutation: (operation: () => Promise<unknown>) => Promise<boolean>;
}) {
  return (
    <label>
      <input
        type="checkbox"
        checked={props.enabled}
        disabled={props.disabled}
        onChange={(event) => props.runMutation(async () => {
          await setMemorySpaceParticipation({ spaceId: props.spaceId, enabled: event.target.checked });
        })}
      />
      在当前 Space 中启用自动记忆
    </label>
  );
}

/**
 * Space 长期记忆只读视图 + 用户直接编辑（正式设计 §11.5/§14）。
 * 「记住了什么」由正文说明；时间与来源（模型整理/用户编辑）随视图展示。
 * 直接编辑经 writeSpaceMemory CAS 保存，不调用模型；空正文表示当前记忆为空。
 */
function SpaceMemoryEditor(props: {
  readonly spaceId: string;
  readonly runMutation: (operation: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [view, setView] = useState<SpaceMemoryView | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const response = await fetchSpaceMemoryView(props.spaceId);
      setView(response.view);
      setDraft(response.view.document?.markdown ?? "");
      setLoadError(null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "无法读取 Space 记忆");
    }
  }, [props.spaceId]);

  useEffect(() => { void reload(); }, [reload]);

  if (loadError !== null) {
    return <p className="memory-error" role="alert">{loadError}</p>;
  }
  if (view === null) {
    return <p className="memory-hint">正在加载长期记忆…</p>;
  }
  const dirty = draft !== (view.document?.markdown ?? "");
  return (
    <div className="memory-space-editor">
      <div className="memory-space-editor-meta">
        <span>
          长期记忆 revision {view.document?.revision ?? "—"}
          {view.document === undefined ? "" : view.document.origin === "user_edit" ? " · 用户编辑" : " · 模型整理"}
        </span>
        <span>整理时间：{view.lastMaintenanceAt === null ? "—" : new Date(view.lastMaintenanceAt).toLocaleString()}</span>
        <span>会话总结：{view.summaryCount} 份</span>
      </div>
      <textarea
        value={draft ?? ""}
        rows={10}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        aria-label="Space 长期记忆正文"
      />
      <p className="memory-hint">
        直接编辑会立即保存为新版本并撤销被替换的旧版供给；清空正文表示当前记忆为空，
        不等于清除自动记忆。会话总结与原始对话可在对话中由模型经 search_history / read_history 查询。
      </p>
      <button
        type="button"
        disabled={!dirty}
        onClick={() => void props.runMutation(async () => {
          await writeSpaceMemory({
            spaceId: props.spaceId,
            expectedRevisionId: view.document?.revisionId ?? null,
            markdown: draft ?? "",
            requestId: `memory-edit-${Date.now()}`,
          });
          await reload();
        })}
      >
        保存长期记忆
      </button>
    </div>
  );
}

function ConfirmClear(props: {
  readonly scope: MemoryScope;
  readonly onCancel: () => void;
  readonly onConfirm: () => Promise<void>;
}) {
  return (
    <div className="memory-clear-confirm" role="alertdialog">
      <p>这会删除{props.scope.kind === "global" ? "全部" : "此 Space"}自动记忆及其检索数据；对话记录、协作规则和路径依赖不受影响，此操作不可恢复。</p>
      <button type="button" onClick={props.onCancel}>取消</button>
      <button type="button" className="danger" onClick={() => void props.onConfirm()}>确认清除</button>
    </div>
  );
}
