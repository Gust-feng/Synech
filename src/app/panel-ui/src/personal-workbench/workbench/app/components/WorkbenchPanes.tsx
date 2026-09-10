import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Split from "split.js";
import { readLocalPreference, writeLocalPreference } from "../../../../shell/local-preferences";
import { WORKBENCH_SPLIT, type WorkbenchLayoutMode, type WorkbenchPane } from "../../../../workbench/layout-state";
import { MOTION_EASING, MOTION_TIMING, useMotionEnabled } from "../../../../shell/motion-system";
import { WorkbenchExplorerSlot } from "../../../../workbench/explorer-slot";
import "./workbench-panes.css";

const SPLIT_RATIO_KEY = "workbench.reading-ratio";

export function WorkbenchPanes(props: {
  readonly mode: WorkbenchLayoutMode;
  readonly reading: ReactNode;
  readonly conversation: ReactNode;
  readonly onActivePaneChange: (pane: WorkbenchPane) => void;
  readonly onContentResize: (width: number) => void;
}) {
  const [explorerSlot, setExplorerSlot] = useState<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const readingRef = useRef<HTMLDivElement>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<Split.Instance | null>(null);
  const draggingRef = useRef(false);
  const animationsRef = useRef<Animation[]>([]);
  const previousModeRef = useRef(props.mode);
  const readingWidthRef = useRef(640);
  const conversationWidthRef = useRef(420);
  const ratioRef = useRef<number | undefined>(undefined);
  if (ratioRef.current === undefined) {
    const value = Number(readLocalPreference(SPLIT_RATIO_KEY));
    ratioRef.current = Number.isFinite(value) && value > 0 && value < 100 ? value : WORKBENCH_SPLIT.defaultReadingRatio;
  }
  const motionEnabled = useMotionEnabled();
  const split = props.mode === "split";
  const readingHidden = props.mode === "conversation";
  const conversationHidden = props.mode === "reading";

  const stopAnimations = useCallback(() => {
    animationsRef.current.forEach((animation) => animation.cancel());
    animationsRef.current = [];
  }, []);

  const rememberWidths = useCallback(() => {
    for (const [element, memory] of [[readingRef.current, readingWidthRef], [conversationRef.current, conversationWidthRef]] as const) {
      if (element !== null && element.dataset.hidden !== "true") memory.current = element.clientWidth;
    }
  }, []);

  const updateSeparator = useCallback((sizes: number[]) => {
    const separator = separatorRef.current;
    const width = contentRef.current?.clientWidth ?? 0;
    if (separator === null || width === 0) return;
    separator.setAttribute("aria-valuenow", String(Math.round(sizes[0]!)));
    separator.setAttribute("aria-valuemin", String(Math.ceil((WORKBENCH_SPLIT.readingMinimum + WORKBENCH_SPLIT.gutter / 2) / width * 100)));
    separator.setAttribute("aria-valuemax", String(Math.floor(100 - (WORKBENCH_SPLIT.conversationMinimum + WORKBENCH_SPLIT.gutter / 2) / width * 100)));
  }, []);

  const rememberRatio = useCallback((sizes: number[]) => {
    ratioRef.current = sizes[0]!;
    writeLocalPreference(SPLIT_RATIO_KEY, String(ratioRef.current));
    updateSeparator(sizes);
    rememberWidths();
  }, [rememberWidths, updateSeparator]);

  // The splitter exists only in split mode. Single surfaces never depend on a hidden panel's size.
  useLayoutEffect(() => {
    const reading = readingRef.current;
    const conversation = conversationRef.current;
    const separator = separatorRef.current;
    if (!split || reading === null || conversation === null || separator === null) return;
    const instance = Split([reading, conversation], {
      sizes: [ratioRef.current!, 100 - ratioRef.current!],
      minSize: [WORKBENCH_SPLIT.readingMinimum, WORKBENCH_SPLIT.conversationMinimum],
      gutterSize: WORKBENCH_SPLIT.gutter,
      snapOffset: 0,
      gutter: () => separator,
      onDragStart: () => {
        stopAnimations();
        draggingRef.current = true;
        contentRef.current?.setAttribute("data-resizing", "true");
      },
      onDrag: updateSeparator,
      onDragEnd: (sizes) => {
        draggingRef.current = false;
        contentRef.current?.removeAttribute("data-resizing");
        rememberRatio(sizes);
      },
    });
    splitRef.current = instance;
    updateSeparator(instance.getSizes());
    rememberWidths();
    return () => {
      // Finish our active gesture before removing its listeners and inline widths.
      if (draggingRef.current) window.dispatchEvent(new MouseEvent("mouseup"));
      instance.destroy(false, true);
      splitRef.current = null;
      contentRef.current?.removeAttribute("data-resizing");
    };
  }, [rememberRatio, rememberWidths, split, stopAnimations, updateSeparator]);

  useLayoutEffect(() => {
    const element = contentRef.current;
    if (element === null) return;
    const measure = () => {
      props.onContentResize(element.clientWidth);
      const instance = splitRef.current;
      if (instance !== null && !draggingRef.current) {
        instance.setSizes([ratioRef.current!, 100 - ratioRef.current!]);
        updateSeparator(instance.getSizes());
      }
      rememberWidths();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.onContentResize, rememberWidths, updateSeparator]);

  // Presentation only: geometry is already committed and animations cannot change the selected mode.
  useLayoutEffect(() => {
    const previousMode = previousModeRef.current;
    const changed = previousMode !== props.mode;
    previousModeRef.current = props.mode;
    stopAnimations();
    if (changed && motionEnabled && previousMode !== "split") {
      const incoming = previousMode === "reading" ? conversationRef.current : readingRef.current;
      animationsRef.current = incoming === null || incoming.dataset.hidden === "true" ? [] : [incoming.animate(
        [{ opacity: 0, transform: "translateX(6px)" }, { opacity: 1, transform: "none" }],
        { duration: MOTION_TIMING.interaction * 1000, easing: "cubic-bezier(" + MOTION_EASING.standard.join(",") + ")" },
      )];
    }
    rememberWidths();
    return stopAnimations;
  }, [motionEnabled, props.mode, rememberWidths, stopAnimations]);

  const resize = (readingRatio: number) => {
    const instance = splitRef.current;
    if (instance === null) return;
    stopAnimations();
    instance.setSizes([readingRatio, 100 - readingRatio]);
    rememberRatio(instance.getSizes());
  };

  return (
    <WorkbenchExplorerSlot.Provider value={explorerSlot}>
      <div className="ui-workbench-pane-shell">
        <div ref={setExplorerSlot} className="ui-workbench-explorer-slot" />
        <div ref={contentRef} className="ui-workbench-panes" data-layout={props.mode}>
          <div
            ref={readingRef}
            id="workbench-reading-pane"
            className="ui-workbench-pane"
            data-hidden={readingHidden}
            aria-hidden={readingHidden}
            inert={readingHidden}
            style={{ "--hidden-pane-width": readingWidthRef.current + "px" } as CSSProperties}
            onFocusCapture={(event) => {
              if (!event.currentTarget.contains(event.target as Node)) return;
              stopAnimations();
              props.onActivePaneChange("reading");
            }}
            onPointerDownCapture={(event) => {
              if (!event.currentTarget.contains(event.target as Node)) return;
              stopAnimations();
              props.onActivePaneChange("reading");
            }}
          >
            <div className="ui-workbench-pane-body ui-workbench-reading">{props.reading}</div>
          </div>
          <div
            ref={separatorRef}
            className="ui-workbench-separator"
            role="separator"
            aria-label="调整阅读与对话宽度"
            aria-orientation="vertical"
            aria-controls="workbench-reading-pane"
            aria-hidden={!split}
            tabIndex={split ? 0 : -1}
            title="拖动调整宽度，双击恢复比例"
            onDoubleClick={() => resize(WORKBENCH_SPLIT.defaultReadingRatio)}
            onKeyDown={(event) => {
              if (!split || !["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(event.key)) return;
              event.preventDefault();
              const current = splitRef.current?.getSizes()[0] ?? WORKBENCH_SPLIT.defaultReadingRatio;
              const step = event.shiftKey ? 10 : 2;
              resize(event.key === "Home" ? 0 : event.key === "End" ? 100 : event.key === "Enter" ? WORKBENCH_SPLIT.defaultReadingRatio : current + (event.key === "ArrowLeft" ? -step : step));
            }}
          />
          <div
            ref={conversationRef}
            id="workbench-conversation-pane"
            className="ui-workbench-pane"
            data-hidden={conversationHidden}
            aria-hidden={conversationHidden}
            inert={conversationHidden}
            style={{ "--hidden-pane-width": conversationWidthRef.current + "px" } as CSSProperties}
            onFocusCapture={(event) => {
              if (!event.currentTarget.contains(event.target as Node)) return;
              stopAnimations();
              props.onActivePaneChange("conversation");
            }}
            onPointerDownCapture={(event) => {
              if (!event.currentTarget.contains(event.target as Node)) return;
              stopAnimations();
              props.onActivePaneChange("conversation");
            }}
          >
            <div className="ui-workbench-pane-body">{props.conversation}</div>
          </div>
        </div>
      </div>
    </WorkbenchExplorerSlot.Provider>
  );
}
