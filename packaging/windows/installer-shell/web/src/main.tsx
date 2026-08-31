import { motion, useReducedMotion } from "motion/react";
import { Folder } from "lucide-react";
import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import installerArtwork from "./assets/installer-artwork.png";
import { CompletionCardStage } from "./completion-card-stage";
import {
  postHostCommand,
  subscribeToHost,
  type InstallActivityId,
  type InstallArtifact,
  type InstallLocationPayload,
  type InstallPhase,
} from "./host";
import { createInstallActivityState, reduceInstallActivity, type InstallActivityRecord, type InstallActivityState } from "./install-activity-state";
import { failureAction } from "./install-state";
import "./styles.css";

type ShortcutOptions = {
  readonly createStartMenuShortcut: boolean;
  readonly createDesktopShortcut: boolean;
};

const defaultShortcutOptions: ShortcutOptions = {
  createStartMenuShortcut: true,
  createDesktopShortcut: false,
};

type SurfaceMode = "configure" | "launching" | "install" | "settling" | "celebration" | "failed";

type WriteProgress = {
  readonly written: number;
  readonly total: number;
};

function InstallerApp(): React.JSX.Element {
  const reduceMotion = useReducedMotion() ?? false;
  const [phase, setPhase] = useState<InstallPhase>("configure");
  const [location, setLocation] = useState<InstallLocationPayload>({
    installParentPath: "",
    installPath: "",
    requiredBytes: 0,
    availableBytes: 0,
  });
  const [shortcutOptions, setShortcutOptions] = useState(defaultShortcutOptions);
  const [activityState, setActivityState] = useState<InstallActivityState>(createInstallActivityState);
  const [artifacts, setArtifacts] = useState<readonly InstallArtifact[]>([]);
  const [writeProgress, setWriteProgress] = useState<WriteProgress | null>(null);
  const [writeDone, setWriteDone] = useState(false);
  const [writeRate, setWriteRate] = useState<number | null>(null);
  const rateSamplesRef = useRef<{ t: number; bytes: number }[]>([]);
  const [failureCode, setFailureCode] = useState<string>();
  const [installAttempt, setInstallAttempt] = useState(0);
  const [isStartingInstall, setIsStartingInstall] = useState(false);
  const [focusContinueOnReady, setFocusContinueOnReady] = useState(false);
  const [celebrationVisible, setCelebrationVisible] = useState(false);
  const continueButtonRef = useRef<HTMLButtonElement>(null);
  const installStartTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(installStartTimerRef.current), []);

  useEffect(() => subscribeToHost((message) => {
    if (message.type === "host.ready" || message.type === "directory.selected") {
      setLocation(message.payload);
      if (message.type === "host.ready") setFocusContinueOnReady(true);
      return;
    }
    if (message.type === "install.phase") {
      setPhase(message.payload.phase);
      return;
    }
    if (message.type === "install.activity") {
      const activity = message.payload;
      setActivityState((current) => reduceInstallActivity(current, activity));
      if (activity.id === "install-application") {
        if (activity.state === "progress") {
          setWriteProgress({
            written: activity.objects[0]?.sizeBytes ?? 0,
            total: Number(activity.objects[0]?.value ?? 0),
          });
        }
        if (activity.state === "completed") setWriteDone(true);
      }
      return;
    }
    if (message.type === "install.artifacts") {
      setArtifacts(message.payload.artifacts);
      return;
    }
    setCelebrationVisible(false);
    setFailureCode(message.payload.code);
    setPhase("failed");
  }), []);

  useEffect(() => {
    postHostCommand({ type: "shell.ready" });
  }, []);

  useEffect(() => {
    if (!focusContinueOnReady || phase !== "configure" || location.installParentPath.length === 0) return;
    continueButtonRef.current?.focus();
    setFocusContinueOnReady(false);
  }, [focusContinueOnReady, location.installParentPath, phase]);

  // 写入速率只由真实进度事件推导：1.5 秒滑动窗口内的字节差。
  useEffect(() => {
    if (writeProgress === null) return;
    const now = performance.now();
    const samples = rateSamplesRef.current;
    samples.push({ t: now, bytes: writeProgress.written });
    while (samples.length > 1 && now - samples[0].t > 1500) samples.shift();
    if (samples.length < 2) return;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const seconds = (last.t - first.t) / 1000;
    if (seconds < 0.05) return;
    const rate = (last.bytes - first.bytes) / seconds;
    setWriteRate(rate > 0 ? rate : null);
  }, [writeProgress]);

  const isBusy = isBusyPhase(phase);
  const recovery = failureAction(failureCode);
  const diskSpaceInsufficient = location.availableBytes > 0 && location.requiredBytes > location.availableBytes;
  const surfaceMode: SurfaceMode = phase === "failed"
    ? "failed"
    : celebrationVisible
      ? "celebration"
      : isStartingInstall
        ? "launching"
      : phase === "completed"
      ? "settling"
      : isInstallPhase(phase)
        ? "install"
        : "configure";

  const beginInstall = (): void => {
    window.clearTimeout(installStartTimerRef.current);
    setIsStartingInstall(true);
    installStartTimerRef.current = window.setTimeout(() => setIsStartingInstall(false), 560);
    setFailureCode(undefined);
    setArtifacts([]);
    setActivityState(createInstallActivityState());
    setWriteProgress(null);
    setWriteDone(false);
    setWriteRate(null);
    setCelebrationVisible(false);
    rateSamplesRef.current = [];
    setInstallAttempt((current) => current + 1);
    setPhase("preparing");
    postHostCommand({
      type: "install.start",
      payload: { installParentPath: location.installParentPath, ...shortcutOptions },
    });
  };

  const retry = (): void => {
    setFailureCode(undefined);
    beginInstall();
  };

  const startCelebration = (): void => {
    setCelebrationVisible(true);
  };

  return (
    <main className={`installer phase-${phase}${surfaceMode === "celebration" ? " is-completion-scene" : ""}`}>
      <div className="window-drag-region" aria-hidden="true" />
      <div
        className="installer-layout"
        aria-hidden={surfaceMode === "celebration" || undefined}
        inert={surfaceMode === "celebration" ? true : undefined}
      >
        <aside className="artwork-panel" aria-hidden="true">
          <div className="artwork-frame">
            <img src={installerArtwork} alt="" draggable={false} />
          </div>
        </aside>

        <section className="content-panel">
          <header className="brand-row">
            <div className={`wordmark${surfaceMode === "configure" ? "" : " is-hidden"}`}><span className="wordmark-mark" />Synech</div>
            <button
              className="window-close"
              type="button"
              aria-label="关闭安装器"
              title="关闭"
              disabled={isBusy}
              onClick={() => postHostCommand({ type: "window.close" })}
            >
              <span aria-hidden="true" />
            </button>
          </header>

          <div className="installer-surface">
            <div className="surface-heading">
              <h1 className={`surface-title mode-${surfaceMode}`}>
                <span className="surface-title-configure" aria-hidden={surfaceMode !== "configure"}>选择安装位置</span>
                <span className="surface-title-install" aria-hidden={surfaceMode !== "install" && surfaceMode !== "launching"}>正在安装 Synech</span>
                <span className="surface-title-settling" aria-hidden={surfaceMode !== "settling"}>安装完成</span>
                <span className="surface-title-failed" aria-hidden={surfaceMode !== "failed"}>没有安装完成</span>
              </h1>
            </div>

            <div className="stage-viewport">
              <div
                className={`configure-stage stage-layer${surfaceMode === "configure" ? " is-visible" : surfaceMode === "launching" ? " is-launching" : " is-hidden"}`}
                aria-hidden={surfaceMode !== "configure"}
                inert={surfaceMode !== "configure" ? true : undefined}
              >
                  <div className="path-field">
                    <span className="path-label">安装位置</span>
                    <span className="path-value" title={location.installPath}>{location.installPath || "正在读取..."}</span>
                    <button
                      type="button"
                      className="path-change"
                      disabled={isBusy || location.installParentPath.length === 0}
                      onClick={() => postHostCommand({ type: "directory.browse" })}
                    >更改</button>
                  </div>
                  <ConfigureControls
                    location={location}
                    options={shortcutOptions}
                    diskSpaceInsufficient={diskSpaceInsufficient}
                    continueButtonRef={continueButtonRef}
                    onOptionsChange={setShortcutOptions}
                    onContinue={beginInstall}
                  />
              </div>
              <InstallStepsStage
                key={`install-attempt-${installAttempt}`}
                activityState={activityState}
                artifacts={artifacts}
                installPath={location.installPath}
                writeProgress={writeProgress}
                writeDone={writeDone}
                writeRate={writeRate}
                reduceMotion={reduceMotion}
                indeterminate={phase === "preparing" || (phase === "installing" && writeProgress === null && !writeDone)}
                visible={surfaceMode === "launching" || surfaceMode === "install" || surfaceMode === "settling"}
                starting={surfaceMode === "launching"}
                settling={surfaceMode === "settling"}
                onSettled={startCelebration}
              />
              {phase === "failed" && (
                  <FailureControls
                    failureCode={failureCode}
                    primary={recovery.primary}
                    retryLabel={recovery.retryLabel}
                    changeLocationLabel={recovery.changeLocationLabel}
                    onRetry={retry}
                    onChangeLocation={() => {
                      setFailureCode(undefined);
                      setArtifacts([]);
                      setPhase("configure");
                    }}
                  />
              )}
            </div>
          </div>
        </section>
      </div>
      <CompletionCardStage
        visible={celebrationVisible}
        reduceMotion={reduceMotion}
        onLaunch={() => postHostCommand({ type: "app.open" })}
        onClose={() => postHostCommand({ type: "window.close" })}
      />
    </main>
  );
}

function ConfigureControls(props: {
  readonly location: InstallLocationPayload;
  readonly options: ShortcutOptions;
  readonly diskSpaceInsufficient: boolean;
  readonly continueButtonRef: React.RefObject<HTMLButtonElement | null>;
  readonly onOptionsChange: (options: ShortcutOptions) => void;
  readonly onContinue: () => void;
}): React.JSX.Element {
  return (
    <motion.div className="configure-controls" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, y: -8 }} transition={contentTransition}>
      <p className={`disk-space${props.diskSpaceInsufficient ? " is-insufficient" : ""}`}>
        {diskSpaceCopy(props.location)}
      </p>
      <fieldset className="shortcut-options">
        <legend>安装选项</legend>
        <ShortcutOption
          checked={props.options.createStartMenuShortcut}
          label="创建开始菜单快捷方式"
          onChange={(checked) => props.onOptionsChange({ ...props.options, createStartMenuShortcut: checked })}
        />
        <ShortcutOption
          checked={props.options.createDesktopShortcut}
          label="创建桌面快捷方式"
          onChange={(checked) => props.onOptionsChange({ ...props.options, createDesktopShortcut: checked })}
        />
      </fieldset>
      <div className="configure-action-row">
        <button
          type="button"
          className="install-action"
          ref={props.continueButtonRef}
          disabled={props.location.installParentPath.length === 0 || props.diskSpaceInsufficient}
          onClick={props.onContinue}
        >继续</button>
      </div>
    </motion.div>
  );
}

function ShortcutOption(props: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="shortcut-option">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.currentTarget.checked)} />
      <span className="shortcut-check" aria-hidden="true"><i /></span>
      <span>{props.label}</span>
    </label>
  );
}

type LogLine = {
  readonly key: string;
  readonly kind: "activity" | "file";
  readonly activityId: InstallActivityId;
  readonly verb: string;
  readonly detail: string;
};

// 每行 = 一个真实到达的事件（活动或文件），只放真实载荷。
function extractProgressDetail(activity: InstallActivityRecord): string {
  const progress = activity.objects[0];
  const written = progress?.sizeBytes ?? 0;
  const total = Number(progress?.value ?? 0);
  if (!Number.isFinite(total) || total <= 0) return formatBytes(written);
  return `${formatBytes(written)} / ${formatBytes(total)}`;
}

function activityLine(activity: InstallActivityRecord, installPath: string): LogLine {
  if (activity.id === "prepare-installer") {
    const detail = activity.state === "progress" ? extractProgressDetail(activity) : activity.objects[0]?.path ?? "Synech-Setup.exe";
    return { key: "activity:prepare-installer", kind: "activity", activityId: activity.id, verb: "extract", detail };
  }
  if (activity.id === "install-application") {
    const detail = activity.state === "progress"
      ? extractProgressDetail(activity)
      : activity.objects[0]?.path ?? installPath;
    return { key: "activity:install-application", kind: "activity", activityId: activity.id, verb: "install", detail };
  }
  if (activity.id === "verify-application-files") {
    const target = activity.objects.find((object) => object.kind === "executable") ?? activity.objects[0];
    return { key: "activity:verify-application-files", kind: "activity", activityId: activity.id, verb: "verify", detail: target?.path ?? installPath };
  }
  if (activity.id === "verify-uninstall-info") {
    const target = activity.objects.find((object) => object.kind === "registry") ?? activity.objects[0];
    return { key: "activity:verify-uninstall-info", kind: "activity", activityId: activity.id, verb: "register", detail: target?.path ?? installPath };
  }
  if (activity.id === "sync-shortcuts") {
    const shortcut = activity.objects.find((object) => object.kind === "shortcut");
    return { key: "activity:sync-shortcuts", kind: "activity", activityId: activity.id, verb: "shortcut", detail: shortcut?.path ?? "未创建快捷方式" };
  }
  const target = activity.objects[0];
  return {
    key: `activity:${activity.id}`,
    kind: "activity",
    activityId: activity.id,
    verb: activity.kind,
    detail: target?.path ?? installPath,
  };
}

// 与 styles.css 中 --install-log-visible-lines 保持同一事实；改行数时两处同步。
const logWindowLines = 9;
// 收尾确认后只留一小段呼吸时间；完成入口不应让用户再等一轮动画。
const completionHoldMs = 600;

// 日志不做人为节流：事件到达即呈现，突发就是一次突发，窗口只限制可见行数。
function useInstallLog(
  current: InstallActivityRecord | undefined,
  artifacts: readonly InstallArtifact[],
  installPath: string,
): readonly LogLine[] {
  const [lines, setLines] = useState<readonly LogLine[]>([]);
  const seenFilesRef = useRef(new Set<string>());
  const lastActivityIdRef = useRef<InstallActivityId | "">("");

  useEffect(() => {
    if (current === undefined) return;
    if (lastActivityIdRef.current === current.id) {
      // 同一活动的后续事件：progress 原地更新计数，completed 恢复为路径
      if (current.state === "started") return;
      const detail = activityLine(current, installPath).detail;
      setLines((previous) => previous.map((line) => (
        line.kind === "activity" && line.activityId === current.id ? { ...line, detail } : line
      )));
      return;
    }
    lastActivityIdRef.current = current.id;
    const line = activityLine(current, installPath);
    setLines((previous) => [...previous, line].slice(-120));
  }, [current, installPath]);

  useEffect(() => {
    if (artifacts.length === 0) return;
    const fresh: LogLine[] = [];
    for (const file of artifacts) {
      const key = file.key?.trim() || file.path.trim();
      if (key === "" || seenFilesRef.current.has(key)) continue;
      seenFilesRef.current.add(key);
      fresh.push({
        key,
        kind: "file",
        activityId: "install-application",
        verb: "write",
        detail: `${stripInstallRoot(file.path, installPath)} · ${formatBytes(file.sizeBytes)}`,
      });
    }
    if (fresh.length === 0) return;
    setLines((previous) => [...previous, ...fresh].slice(-120));
  }, [artifacts, installPath]);

  return lines;
}

function stripInstallRoot(path: string, installPath: string): string {
  const prefix = installPath.replace(/[\\/]+$/u, "");
  if (prefix === "" || path.length <= prefix.length) return path;
  if (path.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return path;
  const rest = path.slice(prefix.length).replace(/^[\\/]+/u, "");
  return rest === "" ? path : rest;
}

// 进度条只做呈现平滑：帧级指数趋近真实比例，数值本身永远是真实值，且单调不回退。
function useSmoothedProgress(target: number | null, reduceMotion: boolean): number | null {
  const [display, setDisplay] = useState<number | null>(null);
  const displayRef = useRef(0);
  const frameRef = useRef(0);
  const hasTargetRef = useRef(false);

  useLayoutEffect(() => {
    if (target === null) return;
    // 首个真实字节比例直接种入，避免移除不定态滑块时先绘制 0% 空条。
    if (!hasTargetRef.current) {
      hasTargetRef.current = true;
      displayRef.current = target;
      setDisplay(target);
      return;
    }
    if (reduceMotion) {
      displayRef.current = Math.max(displayRef.current, target);
      setDisplay(displayRef.current);
      return;
    }
    cancelAnimationFrame(frameRef.current);
    let lastTime = 0;
    const step = (time: number) => {
      if (lastTime === 0) lastTime = time;
      const dt = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;
      const goal = Math.max(displayRef.current, target);
      const next = displayRef.current + (goal - displayRef.current) * (1 - Math.exp(-dt / 0.28));
      displayRef.current = goal - next < 0.05 ? goal : next;
      setDisplay(displayRef.current);
      if (displayRef.current < goal) frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameRef.current);
  }, [target, reduceMotion]);

  // Layout effect 会在浏览器绘制前提交首个值；fallback 也让首个数字 target
  // 在任何非可视化渲染环境中保持一致，不经过可见的 0% 中间态。
  return display ?? (target === null ? null : target);
}

function InstallStepsStage(props: {
  readonly activityState: InstallActivityState;
  readonly artifacts: readonly InstallArtifact[];
  readonly installPath: string;
  readonly writeProgress: WriteProgress | null;
  readonly writeDone: boolean;
  readonly writeRate: number | null;
  readonly reduceMotion: boolean;
  readonly indeterminate: boolean;
  readonly visible: boolean;
  readonly starting: boolean;
  readonly settling: boolean;
  readonly onSettled: () => void;
}): React.JSX.Element {
  const current = props.activityState.current;
  // 真实比例 = 已写入字节 / 目标文件总字节；写入完成是真实事件，此时进度记为 100%。
  // 准备阶段没有可与安装目标对应的百分比，因此只展示同一轨道内的循环状态。
  const realRatio = props.writeProgress === null || props.writeProgress.total <= 0
    ? null
    : Math.min(Math.max(props.writeProgress.written / props.writeProgress.total, 0), 1);
  const target = props.writeDone
    ? 100
    : realRatio !== null && props.writeProgress !== null && props.writeProgress.written > 0
      ? realRatio * 100
      : null;
  const percent = useSmoothedProgress(target, props.reduceMotion);
  const hasProgressData = props.writeProgress !== null && props.writeProgress.written > 0;

  const lines = useInstallLog(current, props.artifacts, props.installPath);
  const runningActivityId = current !== undefined && current.state !== "completed" ? current.id : "";
  const visibleLines = lines.slice(-logWindowLines);
  const settledRef = useRef(false);
  const completionHoldTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(completionHoldTimerRef.current), []);

  useEffect(() => {
    if (!props.settling) {
      settledRef.current = false;
      window.clearTimeout(completionHoldTimerRef.current);
      completionHoldTimerRef.current = undefined;
    }
  }, [props.settling]);

  const finishSettling = (event: React.AnimationEvent<HTMLDivElement>): void => {
    if (event.animationName !== "installation-confirmed" || settledRef.current) return;
    settledRef.current = true;
    completionHoldTimerRef.current = window.setTimeout(props.onSettled, completionHoldMs);
  };

  return (
    <div
      className={`install-stream stage-layer${props.visible ? " is-visible" : " is-hidden"}${props.starting ? " is-starting" : ""}${props.settling ? " is-settling" : ""}`}
      aria-hidden={!props.visible}
    >
      <div className="install-target-context">
        <Folder size={15} strokeWidth={1.55} aria-hidden="true" />
        <code title={props.installPath}>{props.installPath || "正在读取安装目录"}</code>
      </div>

      <div
        className="install-progress"
        role="status"
        aria-live="polite"
        aria-busy={props.indeterminate}
        aria-label={props.indeterminate ? "正在安装 Synech" : undefined}
      >
        <div className="install-progress-row">
          <div
            className={`install-progress-track${props.indeterminate ? " is-indeterminate" : ""}`}
          >
            <div
              className="install-progress-fill"
              style={{ width: `${percent ?? 0}%` }}
              onAnimationEnd={props.settling ? finishSettling : undefined}
            />
          </div>
        </div>
        <p className={`install-progress-data${hasProgressData ? "" : " is-empty"}`} aria-hidden={!hasProgressData}>
          {hasProgressData && props.writeProgress !== null && (
            <>
              {formatBytes(props.writeProgress.written)} / {formatBytes(props.writeProgress.total)}
              {!props.writeDone && props.writeRate !== null && <span> · {formatBytes(props.writeRate)}/s</span>}
            </>
          )}
        </p>
      </div>

      <ol className="install-log">
        {visibleLines.map((line) => (
          <li
            key={line.key}
            className={`install-log-line${line.activityId === runningActivityId ? " is-running" : ""}`}
          >
            <span className="install-log-verb">{line.verb}</span>
            <code className="install-log-detail" title={line.detail}>{line.detail}</code>
          </li>
        ))}
      </ol>
    </div>
  );
}

function FailureControls(props: {
  readonly failureCode: string | undefined;
  readonly primary: "retry" | "change-location";
  readonly retryLabel: string;
  readonly changeLocationLabel: string;
  readonly onRetry: () => void;
  readonly onChangeLocation: () => void;
}): React.JSX.Element {
  const retryButton = (
    <button type="button" className={props.primary === "retry" ? "install-action" : "secondary-action"} onClick={props.onRetry}>{props.retryLabel}</button>
  );
  const changeLocationButton = (
    <button type="button" className={props.primary === "change-location" ? "install-action" : "secondary-action"} onClick={props.onChangeLocation}>{props.changeLocationLabel}</button>
  );
  return (
    <motion.div
      className="failure-controls stage-layer"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0, transition: stageEnterTransition }}
      exit={{ opacity: 0, y: -8, transition: stageExitTransition }}
    >
      <div className="failure-event">
        <span aria-hidden="true">!</span>
        <div><strong>安装活动已停止</strong><p>{failureMessage(props.failureCode)}</p></div>
      </div>
      <div className="failure-actions">
        {props.primary === "retry" ? (
          <>{retryButton}{changeLocationButton}</>
        ) : (
          <>{changeLocationButton}{retryButton}</>
        )}
      </div>
    </motion.div>
  );
}

function isBusyPhase(phase: InstallPhase): boolean {
  return isInstallPhase(phase);
}

function isInstallPhase(phase: InstallPhase): boolean {
  return phase === "preparing" || phase === "installing";
}

function diskSpaceCopy(location: InstallLocationPayload): string {
  if (location.requiredBytes <= 0 || location.availableBytes <= 0) return "正在读取磁盘空间";
  const required = formatBytes(location.requiredBytes, "MB");
  const available = formatBytes(location.availableBytes, "GB");
  if (location.requiredBytes > location.availableBytes) return `需要 ${required} · 当前磁盘空间不足`;
  return `需要 ${required} · 可用 ${available}`;
}

function formatBytes(bytes: number, unit?: "MB" | "GB"): string {
  if (unit === undefined) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  const divisor = unit === "MB" ? 1024 ** 2 : 1024 ** 3;
  const value = bytes / divisor;
  return `${unit === "MB" ? Math.ceil(value) : value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

function failureMessage(code: string | undefined): string {
  switch (code) {
    case "backend_failed":
    case "installation_verification_failed": return "安装未完成，请重试。";
    case "invalid_install_path":
    case "invalid_install_parent": return "请选择其他安装位置。";
    case "install_parent_reparse":
    case "install_target_reparse":
    case "install_target_is_file":
    case "install_target_not_empty":
    case "install_target_product_home_conflict":
    case "install_target_unavailable": return "该位置不可用，请选择其他位置。";
    default: return "安装过程已停止，请重试。";
  }
}

const contentTransition = { duration: 0.32, ease: [0.22, 1, 0.36, 1] } as const;
const stageEnterTransition = { duration: 0.28, ease: [0.22, 1, 0.36, 1] } as const;
const stageExitTransition = { duration: 0.17, ease: [0.4, 0, 1, 1] } as const;

createRoot(document.getElementById("root")!).render(<StrictMode><InstallerApp /></StrictMode>);
