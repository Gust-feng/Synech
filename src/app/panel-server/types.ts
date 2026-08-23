import type { AgentDefinition } from "../agent-prompts/contracts.js";
import type { ConfigCenter } from "../config-center/index.js";
import type { ProcessTerminator } from "../runtime-guard/index.js";
import type { SkillRootInput } from "../skills/index.js";
import type { SubAgentRootInput } from "../sub-agents/sub-agent-loader.js";

export type PanelServerOptions = {
  readonly host?: string;
  readonly port?: number;
  /** Explicit Product Home. Takes precedence over SYNECH_HOME and platform defaults. */
  readonly productHome?: string;
  readonly configCenter?: ConfigCenter;
  readonly providerFetch?: PanelProviderFetch;
  readonly modelCatalogFetch?: PanelModelCatalogFetch;
  readonly directoryPicker?: () => Promise<string | undefined>;
  readonly contextAttachmentPicker?: () => Promise<PanelContextAttachmentSelection | undefined>;
  readonly synechRestorePicker?: () => Promise<string | undefined>;
  readonly externalResourceOpener?: (target: PanelExternalResourceTarget) => Promise<void>;
  readonly additionalSkillRoots?: readonly SkillRootInput[];
  readonly skillRoots?: readonly SkillRootInput[];
  readonly additionalSubAgentRoots?: readonly SubAgentRootInput[];
  readonly subAgentRoots?: readonly SubAgentRootInput[];
  readonly ordinaryAgentDefinition?: AgentDefinition;
  readonly agentDefinitions?: readonly AgentDefinition[];
  readonly processTerminator?: ProcessTerminator;
};

export type PanelExternalResourceTarget =
  | { readonly kind: "path"; readonly value: string }
  | { readonly kind: "url"; readonly value: string };

export type PanelContextAttachmentSelection = {
  readonly kind: "file" | "project";
  readonly path: string;
};

export type PanelContextAttachmentMediaEntry = {
  readonly attachmentId: string;
  readonly kind: "image";
  readonly absolutePath: string;
  readonly mimeType: string;
  readonly byteLength?: number;
  readonly title?: string;
};

export type PanelProviderFetch = (
  url: string,
  init: {
    readonly method: "GET" | "POST";
    readonly headers: Record<string, string>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  }
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly body?: unknown;
  readonly json: () => Promise<unknown>;
  readonly text?: () => Promise<string>;
}>;

export type PanelModelCatalogFetch = (
  url: string,
  init: {
    readonly method: "GET";
    readonly headers: Record<string, string>;
    readonly signal?: AbortSignal;
  }
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly body?: unknown;
  readonly json: () => Promise<unknown>;
  readonly text?: () => Promise<string>;
}>;

export type StartedPanelServer = {
  readonly url: string;
  readonly productHome: string;
  readonly configDirectory: string;
  close(): Promise<void>;
};
