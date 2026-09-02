import { useCallback, useEffect, useState } from "react";
import {
  clearImplicitMemory,
  fetchMemoryCapability,
  setMemoryConsent,
  setMemoryConversationParticipation,
  setMemorySpaceParticipation,
  type MemoryCapabilityStatus,
} from "@panel-api/memory-admin";

type Scope =
  | { readonly kind: "global" }
  | { readonly kind: "space"; readonly id: string }
  | { readonly kind: "conversation"; readonly conversationId: string };

type MemoryScope = { readonly kind: "global" } | { readonly kind: "space"; readonly id: string };

function toMemoryScope(scope: Scope | null): MemoryScope | null {
  if (scope === null) return null;
  if (scope.kind === "conversation") return null;
  return scope;
}

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

function statusText(status: MemoryCapabilityStatus): string {
  if (status.health !== "ready") return HEALTH_LABEL[status.health];
  if (status.rollout === "off") return STATUS_LABEL.off;
  if (status.rollout === "shadow") return STATUS_LABEL.shadow;
  if (status.effective === "active") return STATUS_LABEL.active;
  if (status.effective === "off") return STATUS_LABEL.off;
  return STATUS_LABEL.shadow;
}

function describeHelp(scope: Scope | null): string {
  if (scope === null) {
    return "开启后，Synech 会在该 Space 对话空闲时于后台提炼少量可能对未来有帮助的内容，并在后续相关对话中自动使用。内部记忆不会逐条展示。";
  }
  if (scope.kind === "conversation") {
    return "不读取智能记忆，也不将这段对话用于记忆；原始会话历史仍会保留，协作规则仍然生效。";
  }
  return "关闭期间的内容不会在重新开启后补记。";
}

export type MemorySettingsPanelProps = {
  readonly scope: Scope | null;
  readonly onAfterChange?: () => void;
};

export function MemorySettingsPanel(props: MemorySettingsPanelProps) {
  const [status, setStatus] = useState<MemoryCapabilityStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetchMemoryCapability();
      setStatus(response.status);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取记忆状态");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const runMutation = useCallback(async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
      props.onAfterChange?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }, [props, refresh]);

  if (status === null) {
    return (
      <section className="memory-settings" aria-busy>
        <h2>智能关联记忆</h2>
        <p>{error ?? "正在加载..."}</p>
      </section>
    );
  }

  return (
    <section className="memory-settings">
      <h2>智能关联记忆</h2>
      <p className="memory-status">状态：{statusText(status)}</p>
      <p className="memory-help">{describeHelp(props.scope)}</p>
      {error !== null && <p className="memory-error" role="alert">{error}</p>}
      <fieldset disabled={busy}>
        <label>
          <input
            type="checkbox"
            checked={status.globalConsent}
            onChange={(event) => runMutation(() => setMemoryConsent({ globalConsent: event.target.checked }))}
          />
          允许使用智能关联记忆（全局）
        </label>
        {props.scope?.kind === "space" && (
          <SpaceParticipationControl
            spaceId={props.scope.id}
            runMutation={runMutation}
          />
        )}
        {props.scope?.kind === "conversation" && (
          <ConversationParticipationControl
            conversationId={props.scope.conversationId}
            runMutation={runMutation}
          />
        )}
        {props.scope === null && (
          <p className="memory-hint">清除前请先在左侧选择具体 Space 或对话。</p>
        )}
        {confirmingClear ? (
          <ConfirmClear
            scope={props.scope}
            onCancel={() => setConfirmingClear(false)}
            onConfirm={async () => {
              const memoryScope = toMemoryScope(props.scope);
              if (memoryScope === null) {
                setError("conversation 范围内不提供清除操作（请改用'本对话不参与'）");
                setConfirmingClear(false);
                return;
              }
              await runMutation(async () => {
                await clearImplicitMemory({ scope: memoryScope });
              });
              setConfirmingClear(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="memory-clear"
            onClick={() => setConfirmingClear(true)}
            disabled={props.scope === null || props.scope.kind === "conversation"}
          >
            清除{props.scope === null ? "" : props.scope.kind === "space" ? "此 Space" : "本对话"}的智能记忆
          </button>
        )}
      </fieldset>
    </section>
  );
}

function SpaceParticipationControl(props: {
  readonly spaceId: string;
  readonly runMutation: (operation: () => Promise<unknown>) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/memory/capability", { method: "GET" });
      const data = await response.json() as { ok: true; status: { rollout: string; globalConsent: boolean } };
      // 简化：从能力获取的 globalConsent 推断是否可参与（详细 participation 由 status 携带）
      void data;
      setEnabled(data.status.globalConsent);
    } catch { setEnabled(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return (
    <label>
      <input
        type="checkbox"
        checked={enabled === true}
        disabled={enabled === null}
        onChange={(event) => props.runMutation(async () => {
          await setMemorySpaceParticipation({ spaceId: props.spaceId, enabled: event.target.checked });
          setEnabled(event.target.checked);
        })}
      />
      在当前 Space 中使用
    </label>
  );
}

function ConversationParticipationControl(props: {
  readonly conversationId: string;
  readonly runMutation: (operation: () => Promise<unknown>) => Promise<void>;
}) {
  const [excluded, setExcluded] = useState<boolean>(false);
  return (
    <label>
      <input
        type="checkbox"
        checked={excluded}
        onChange={(event) => props.runMutation(async () => {
          await setMemoryConversationParticipation({ conversationId: props.conversationId, excluded: event.target.checked });
          setExcluded(event.target.checked);
        })}
      />
      本对话不参与智能记忆
    </label>
  );
}

function ConfirmClear(props: {
  readonly scope: Scope | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => Promise<void>;
}) {
  return (
    <div className="memory-clear-confirm" role="alertdialog">
      <p>这会删除此范围的全部智能记忆及其检索数据，包括后台提炼的内容以及未来通过"记住"保存的项目事实。对话记录、协作规则和路径依赖不会删除；清除前的对话不会被自动重新整理。此操作不可恢复。</p>
      <button type="button" onClick={props.onCancel}>取消</button>
      <button type="button" className="danger" onClick={() => void props.onConfirm()}>确认清除</button>
    </div>
  );
}
