import React from "react";
import {
  ChevronDown,
  Code2,
  FileText,
  FlaskConical,
  RefreshCw,
  ScanSearch,
  Search,
  type LucideIcon,
} from "lucide-react";
import type { SubAgentDefinition } from "../contracts/sub-agents";
import "../styles/sub-agent-settings.css";

export function SubAgentSettings(props: {
  readonly subAgents: readonly SubAgentDefinition[];
  readonly refreshing?: boolean;
  readonly onRefresh: () => void;
}): React.ReactElement {
  const enabledCount = props.subAgents.filter((subAgent) => subAgent.enabled).length;
  return (
    <section className="sub-agent-settings">
      <header className="sub-agent-toolbar">
        <div className="sub-agent-toolbar-copy">
          <strong>{props.subAgents.length} 个专家助手</strong>
          <span>Ordinary Agent 会根据任务按需调用</span>
        </div>
        <div className="sub-agent-toolbar-actions">
          <span className="sub-agent-count">{enabledCount} / {props.subAgents.length} 启用</span>
          <button
            type="button"
            className="sub-agent-refresh-button"
            onClick={props.onRefresh}
            disabled={props.refreshing}
          >
            <RefreshCw size={14} />
            {props.refreshing ? "刷新中" : "刷新"}
          </button>
        </div>
      </header>
      {props.subAgents.length === 0 ? (
        <div className="sub-agent-empty">暂无 Sub Agent</div>
      ) : (
        <div className="sub-agent-list" aria-label="Sub Agent 列表">
          {props.subAgents.map((subAgent) => (
            <SubAgentRow
              key={subAgent.id}
              subAgent={subAgent}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SubAgentRow(props: {
  readonly subAgent: SubAgentDefinition;
}): React.ReactElement {
  const hasCategory = props.subAgent.category !== undefined && props.subAgent.category.length > 0;
  const sourceLabel = subAgentSourceLabel(props.subAgent);
  const hasMeta = hasCategory || sourceLabel !== undefined || props.subAgent.version !== undefined;
  const hasWhenToUse = props.subAgent.whenToUse !== undefined && props.subAgent.whenToUse.length > 0;
  const hasWhenNotToUse = props.subAgent.whenNotToUse !== undefined && props.subAgent.whenNotToUse.length > 0;
  const hasDiagnostics = props.subAgent.diagnostics !== undefined && props.subAgent.diagnostics.length > 0;
  const RoleIcon = subAgentRoleIcon(props.subAgent);
  return (
    <details className={`sub-agent-panel ${props.subAgent.enabled ? "" : "disabled"}`}>
      <summary className="sub-agent-panel-summary">
        <span className="sub-agent-role-mark" aria-hidden="true">
          {RoleIcon === undefined ? subAgentInitial(props.subAgent.name) : <RoleIcon size={18} />}
        </span>
        <span className="sub-agent-panel-main">
          <span className="sub-agent-panel-title">
            <strong>{props.subAgent.name}</strong>
          </span>
          <span className="sub-agent-description">{props.subAgent.description || "未填写描述"}</span>
          {hasMeta && (
            <span className="sub-agent-meta">
              {sourceLabel !== undefined && <span>{sourceLabel}</span>}
              {hasCategory && <span>{props.subAgent.category}</span>}
              {props.subAgent.version !== undefined && <span>v{props.subAgent.version}</span>}
            </span>
          )}
        </span>
        <span className="sub-agent-panel-status">
          <span className={props.subAgent.enabled ? "enabled" : "disabled"}>
            <i aria-hidden="true" />
            {props.subAgent.enabled ? "已启用" : "已停用"}
          </span>
          <ChevronDown size={15} aria-hidden="true" />
        </span>
      </summary>
      {(hasWhenToUse || hasWhenNotToUse || hasDiagnostics) && (
        <div className="sub-agent-panel-detail">
          {hasWhenToUse && (
            <section>
              <h4>适用场景</h4>
              <ul>
                {props.subAgent.whenToUse.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            </section>
          )}
          {hasWhenNotToUse && (
            <section>
              <h4>避免使用</h4>
              <ul>
                {props.subAgent.whenNotToUse.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            </section>
          )}
          {hasDiagnostics && (
            <section className="sub-agent-diagnostics">
              <h4>配置提示</h4>
              <ul>
                {props.subAgent.diagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.code}:${diagnostic.path ?? "definition"}:${index}`}>
                    {diagnostic.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </details>
  );
}

function subAgentRoleIcon(subAgent: SubAgentDefinition): LucideIcon | undefined {
  const role = `${subAgent.id} ${subAgent.category ?? ""}`.toLowerCase();
  if (role.includes("code") || role.includes("develop")) return Code2;
  if (role.includes("doc") || role.includes("document") || role.includes("write")) return FileText;
  if (role.includes("research") || role.includes("search")) return Search;
  if (role.includes("review") || role.includes("audit")) return ScanSearch;
  if (role.includes("test") || role.includes("quality")) return FlaskConical;
  return undefined;
}

function subAgentInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "S";
}

function subAgentSourceLabel(subAgent: SubAgentDefinition): string | undefined {
  switch (subAgent.sourceKind) {
    case "builtin":
      return "内置";
    case "project":
      return "项目";
    case "user":
      return "全局";
    case "plugin":
      return "插件";
    case "custom":
      return "自定义";
    default:
      return undefined;
  }
}