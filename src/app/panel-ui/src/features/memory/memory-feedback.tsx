import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";

export function MemoryFeedback(props: {
  readonly kind: "error" | "success" | "warning";
  readonly children: ReactNode;
}): React.ReactElement {
  const Icon = props.kind === "success" ? CheckCircle2 : AlertCircle;
  return <div className="memory-feedback" data-kind={props.kind} role={props.kind === "error" ? "alert" : "status"}>
    <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
    <span>{props.children}</span>
  </div>;
}
