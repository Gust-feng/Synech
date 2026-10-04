import React, { useEffect, useState } from "react";
import { Copy, ExternalLink, LogIn, LogOut, X } from "lucide-react";
import type { ModelProviderAuthResponse } from "@panel-api/config";
import { SettingsSelectControl } from "../components/select-control";
import { useAutoHidden } from "../../../components/use-auto-hidden";

export function ModelProviderAuthPanel(props: {
  readonly auth?: ModelProviderAuthResponse;
  readonly busy: boolean;
  readonly error?: string;
  readonly onStart: () => Promise<void>;
  readonly onCancel: () => Promise<void>;
  readonly onLogout: () => Promise<void>;
  readonly onAnswer: (promptId: string, value: string) => Promise<void>;
}): React.ReactElement {
  const session = props.auth?.authSession;
  const prompt = session?.prompt;
  const pending = session?.status === "pending";
  const [answer, setAnswer] = useState("");
  const [copyError, setCopyError] = useState<string | undefined>(undefined);
  const authError = props.error ?? session?.error?.message ?? copyError;
  const authErrorAutoHidden = useAutoHidden(authError);
  useEffect(() => {
    setAnswer(prompt?.type === "select" ? prompt.options?.[0]?.id ?? "" : "");
    setCopyError(undefined);
  }, [session?.sessionId, prompt?.promptId]);

  const events = session?.events ?? [];
  const device = [...events].reverse().find((event) => event.type === "device_code");
  const login = [...events].reverse().find((event) => event.type === "auth_url");
  const progress = [...events].reverse().find((event) => event.type === "progress" || event.type === "info");
  const loginUrl = safeAuthUrl(device?.verificationUri ?? device?.url ?? login?.url);
  const relatedLinks = new Map(events.flatMap((event) => (event.links ?? []).flatMap((link) => {
    const url = safeAuthUrl(link.url);
    return url === undefined || url === loginUrl ? [] : [[url, link.label ?? "打开链接"] as const];
  })));
  const configured = props.auth?.configured === true;
  const status = pending && prompt !== undefined ? "等待填写登录信息"
    : pending && loginUrl !== undefined ? "等待网页授权"
    : pending ? "正在准备登录"
    : session?.status === "failed" ? "登录失败"
    : session?.status === "cancelled" ? "已取消"
    : configured ? "已登录" : "未登录";

  return (
    <div className="provider-auth-panel provider-form-full">
      <div className="provider-auth-actions">
        <span role="status">{status}</span>
        {pending ? <button
          type="button"
          disabled={props.busy}
          onClick={() => void props.onCancel()}
        ><X size={15} /> 取消登录</button> : <button
          type="button"
          disabled={props.busy}
          onClick={() => void props.onStart()}
        ><LogIn size={15} /> {configured ? "重新登录" : "登录账号"}</button>}
        {configured && !pending && <button
          type="button"
          disabled={props.busy}
          onClick={() => void props.onLogout()}
        ><LogOut size={15} /> 退出登录</button>}
      </div>
      {pending && <>
        {loginUrl !== undefined && <a className="provider-auth-link" href={loginUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={15} /> 打开登录页面
        </a>}
        {[...relatedLinks].map(([url, label]) => <a key={url} className="provider-auth-link" href={url} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={15} /> {label}
        </a>)}
        {device?.userCode !== undefined && <div className="provider-auth-device-code">
          <span>验证码</span>
          <code>{device.userCode}</code>
          <button
            type="button"
            title="复制验证码"
            aria-label="复制验证码"
            onClick={() => {
              void navigator.clipboard.writeText(device.userCode!).catch(() => setCopyError("复制失败。"));
            }}
          ><Copy size={15} /></button>
        </div>}
        {(device?.instructions ?? login?.instructions) !== undefined && <p>{device?.instructions ?? login?.instructions}</p>}
        {progress?.message !== undefined && <p role="status">{progress.message}</p>}
        {prompt !== undefined && <form onSubmit={(event) => {
          event.preventDefault();
          void props.onAnswer(prompt.promptId, answer);
        }}>
          <label>
            <span>{prompt.message}</span>
            {prompt.type === "select" ? <SettingsSelectControl
              id={`provider-auth-prompt-${prompt.promptId}`}
              ariaLabel={prompt.message}
              value={answer}
              options={(prompt.options ?? []).map((option) => ({ value: option.id, label: option.label }))}
              disabled={props.busy}
              onChange={setAnswer}
            /> : <input
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              type={prompt.type === "secret" ? "password" : "text"}
              placeholder={prompt.placeholder}
              disabled={props.busy}
              autoComplete="off"
              spellCheck={false}
            />}
          </label>
          <button type="submit" disabled={props.busy || (prompt.type !== "text" && answer.trim().length === 0)}>继续</button>
        </form>}
      </>}
      {authError !== undefined && !authErrorAutoHidden && <p className="provider-auth-error" role="alert">
        {authError}
      </p>}
    </div>
  );
}

function safeAuthUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href : undefined;
  } catch {
    return undefined;
  }
}
