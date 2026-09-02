import { useCallback, useEffect, useState } from "react";
import {
  clearImplicitMemory,
  fetchMemoryCapability,
  setMemoryConsent,
  setMemoryConversationParticipation,
  setMemorySpaceParticipation,
  type MemoryCapabilityStatus,
} from "@panel-api/memory-admin";
import "./memory.css";

export type MemorySettingsOwner =
  | { readonly kind: "space"; readonly id: string }
  | { readonly kind: "workspace"; readonly id: string };

export type MemorySettingsScope = {
  readonly owner?: MemorySettingsOwner;
  readonly conversationId?: string;
};

type MemoryScope = { readonly kind: "global" } | MemorySettingsOwner;

function toMemoryScope(scope: MemorySettingsScope | null): MemoryScope {
  return scope?.owner ?? { kind: "global" };
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

function describeHelp(scope: MemorySettingsScope | null): string {
  if (scope === null) {
    return "开启后，Synech 会在已参与的 Space 对话空闲时于后台提炼少量可能有帮助的内容，并在后续相关对话中自动使用。内部记忆不会逐条展示，后台整理可能产生少量当前模型服务的 API 用量。";
  }
  if (scope.conversationId !== undefined) {
    return "不读取智能记忆，也不将这段对话用于记忆；原始会话历史仍会保留，协作规则仍然生效。";
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
  const conversationId = props.scope?.conversationId;

  const refresh = useCallback(async () => {
    try {
      const response = await fetchMemoryCapability({
        ...(ownerKind === undefined || ownerId === undefined ? {} : {
          owner: { kind: ownerKind, id: ownerId },
        }),
        ...(conversationId === undefined ? {} : { conversationId }),
      });
      setStatus(response.status);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取记忆状态");
    }
  }, [conversationId, ownerId, ownerKind]);

  useEffect(() => {
    setStatus(null);
    setClearScope(null);
    void refresh();
  }, [refresh]);

  const onAfterChange = props.onAfterChange;
  const runMutation = useCallback(async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
      onAfterChange?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }, [onAfterChange, refresh]);

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
        {props.scope?.owner?.kind === "space" && (
          <SpaceParticipationControl
            spaceId={props.scope.owner.id}
            enabled={status.scopeParticipation === true}
            disabled={!status.globalConsent}
            runMutation={runMutation}
          />
        )}
        {props.scope?.conversationId !== undefined && (
          <ConversationParticipationControl
            conversationId={props.scope.conversationId}
            excluded={status.conversationExcluded === true}
            runMutation={runMutation}
          />
        )}
        {clearScope !== null ? (
          <ConfirmClear
            scope={clearScope}
            onCancel={() => setClearScope(null)}
            onConfirm={async () => {
              await runMutation(async () => {
                await clearImplicitMemory({ scope: clearScope });
              });
              setClearScope(null);
            }}
          />
        ) : (
          <>
            <button
              type="button"
              className="memory-clear"
              onClick={() => setClearScope(toMemoryScope(props.scope))}
            >
              清除{props.scope?.owner === undefined ? "全部" : props.scope.owner.kind === "space" ? "此 Space" : "此工作区"}的智能记忆
            </button>
            {props.scope?.owner !== undefined && (
              <button
                type="button"
                className="memory-clear"
                onClick={() => setClearScope({ kind: "global" })}
              >
                清除全部智能记忆
              </button>
            )}
          </>
        )}
      </fieldset>
    </section>
  );
}

function SpaceParticipationControl(props: {
  readonly spaceId: string;
  readonly enabled: boolean;
  readonly disabled: boolean;
  readonly runMutation: (operation: () => Promise<unknown>) => Promise<void>;
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
      在当前 Space 中使用
    </label>
  );
}

function ConversationParticipationControl(props: {
  readonly conversationId: string;
  readonly excluded: boolean;
  readonly runMutation: (operation: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <label>
      <input
        type="checkbox"
        checked={props.excluded}
        onChange={(event) => props.runMutation(async () => {
          await setMemoryConversationParticipation({ conversationId: props.conversationId, excluded: event.target.checked });
        })}
      />
      本对话不参与智能记忆
    </label>
  );
}

function ConfirmClear(props: {
  readonly scope: MemoryScope;
  readonly onCancel: () => void;
  readonly onConfirm: () => Promise<void>;
}) {
  return (
    <div className="memory-clear-confirm" role="alertdialog">
      <p>这会删除{props.scope.kind === "global" ? "全部" : "此范围"}智能记忆及其检索数据，包括后台提炼的内容以及未来通过"记住"保存的项目事实。对话记录、协作规则和路径依赖不会删除；清除前的对话不会被自动重新整理。此操作不可恢复。</p>
      <button type="button" onClick={props.onCancel}>取消</button>
      <button type="button" className="danger" onClick={() => void props.onConfirm()}>确认清除</button>
    </div>
  );
}
