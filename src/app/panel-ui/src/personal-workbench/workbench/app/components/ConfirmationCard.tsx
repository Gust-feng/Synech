import React from "react";
import { ShieldCheck, X } from "lucide-react";
import type {
  OrdinaryWorkView,
  PendingConfirmation,
  TranscriptConfirmation,
} from "../../../../contracts/run";
import { projectConfirmationDisplay } from "../../../../confirmation-display-projection";

export type ConfirmationProjection =
  | PendingConfirmation
  | NonNullable<OrdinaryWorkView["pendingConfirmation"]>
  | TranscriptConfirmation;

// 风险分级的强调色：高风险走 error 红，中风险走 wait 琥珀，低风险走默认 accent 蓝。
const RISK_ACCENT: Record<"low" | "medium" | "high", string> = {
  low: "var(--aa-accent)",
  medium: "var(--aa-status-wait)",
  high: "var(--aa-status-error)",
};

export function ConfirmationCard(props: {
  readonly confirmation?: ConfirmationProjection;
  readonly busy: boolean;
  readonly onDecision?: (decision: "approve_once" | "deny" | "guidance", guidance?: string) => void;
}): React.ReactElement {
  const view = projectConfirmationDisplay(props.confirmation);
  const accent = RISK_ACCENT[view.riskLevel];
  const isHighRisk = view.riskLevel === "high";
  return (
    <div
      className="space-y-3 py-3"
      data-risk={view.riskLevel}
      style={{
        color: "var(--aa-text-1)",
        borderLeft: `3px solid ${accent}`,
        background: `color-mix(in srgb, ${accent} 7%, transparent)`,
        borderRadius: "6px",
        paddingLeft: "12px",
      }}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <ShieldCheck
          size={15}
          className="mt-0.5 shrink-0"
          style={{ color: accent }}
          aria-hidden="true"
        />
        <div className="min-w-0 space-y-1">
          {view.title.length > 0 && <strong className="block text-xs font-medium">{view.title}</strong>}
          {view.showActionPreview && (
            <p className="whitespace-pre-wrap text-xs leading-5" style={{ color: "var(--aa-text-2)" }}>
              {view.actionPreview}
            </p>
          )}
        </div>
      </div>

      {view.resources.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-1.5 pl-6">
          {view.resources.map((resource) => (
            <code
              key={resource}
              className="max-w-full truncate rounded px-1.5 py-0.5 text-[10px]"
              style={{ background: "var(--aa-surface-hover)", color: "var(--aa-text-2)" }}
              title={resource}
            >
              {resource}
            </code>
          ))}
        </div>
      )}

      {view.resumeLostSummary !== undefined && (
        <p
          className="ml-6 rounded px-2.5 py-2 text-xs leading-5"
          style={{ background: "rgba(212, 144, 32, 0.08)", color: "var(--aa-status-wait)" }}
        >
          {view.resumeLostSummary}
        </p>
      )}

      {props.onDecision !== undefined && (
        <div className="flex items-center gap-2 pl-6">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: isHighRisk ? "var(--aa-status-error)" : accent, color: "#fff" }}
            onClick={() => props.onDecision?.("approve_once")}
            disabled={props.busy || view.resumeLost}
          >
            <ShieldCheck size={12} aria-hidden="true" />
            {props.busy ? "执行中" : "执行"}
          </button>
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors hover:bg-[var(--aa-hover-tint)] disabled:cursor-not-allowed disabled:opacity-50"
            style={{ color: "var(--aa-text-2)" }}
            onClick={() => props.onDecision?.("deny")}
            disabled={props.busy}
          >
            <X size={12} aria-hidden="true" />
            不执行
          </button>
        </div>
      )}
    </div>
  );
}
