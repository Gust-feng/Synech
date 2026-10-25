import { useContext } from "react";
import { Sparkles } from "lucide-react";
import { PreviewLayoutContext } from "../../../../workbench/preview-layout";

/** Only an opened preview can offer split mode; empty lists and directory roots have no control. */
export function CollaborationToggle({ available }: { readonly available: boolean }) {
  const layout = useContext(PreviewLayoutContext);
  if (!available || layout === null) return null;
  return (
    <button
      type="button"
      className="ui-workbench-split-toggle"
      data-split-toggle
      aria-label={layout.splitEnabled ? "结束协作" : "打开协作"}
      title={layout.splitEnabled ? "结束协作，继续阅读" : layout.canSplit ? "阅读时与 AI 协作" : "请加宽窗口后使用协作"}
      aria-pressed={layout.splitEnabled}
      disabled={!layout.canSplit && !layout.splitEnabled}
      onClick={layout.onToggleSplit}
    >
      <Sparkles size={15} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
