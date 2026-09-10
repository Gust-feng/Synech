import { useContext, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { WorkbenchExplorerSlot } from "../../../../workbench/explorer-slot";

/** Directory placement and collapse are independent of the selected reading/conversation layout. */
export function WorkbenchExplorer(props: {
  readonly collapsed: boolean;
  readonly children: ReactNode;
  readonly width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const slot = useContext(WorkbenchExplorerSlot);

  useLayoutEffect(() => {
    if (props.collapsed && ref.current?.contains(document.activeElement)) {
      document.querySelector<HTMLButtonElement>('[data-explorer-toggle]')?.focus({ preventScroll: true });
    }
  }, [props.collapsed]);

  if (slot === null) return null;
  return createPortal(
    <div
      ref={ref}
      className="ui-workbench-explorer"
      data-collapsed={props.collapsed}
      style={{ '--explorer-width': `${props.width ?? 288}px` } as CSSProperties}
      aria-hidden={props.collapsed}
      inert={props.collapsed}
    >
      <div className="ui-workbench-explorer-content">
        {props.children}
      </div>
    </div>,
    slot,
  );
}
