import React from "react";
import type { RuntimeEnvironmentTool } from "../contracts/config";
import { resolveRuntimeToolIconSvg } from "../runtime-tool-icons";

export function RuntimeEnvironmentSettings(props: {
  readonly tools?: readonly RuntimeEnvironmentTool[];
}): React.ReactElement {
  const tools = runtimeTools(props.tools);
  const availableCount = tools.filter((tool) => tool.available).length;
  const missingCount = tools.length - availableCount;
  const summaryTone = missingCount === 0 ? "available" : "missing";

  return (
    <section className="settings-card settings-runtime-card">
      <div className="settings-card-title-row">
        <h3>环境检测</h3>
        <span className="settings-runtime-summary" data-status={summaryTone}>
          {missingCount === 0 ? `已检测 ${tools.length} 项` : `缺少 ${missingCount} 项`}
        </span>
      </div>
      <div className="settings-runtime-list" aria-label="本机工具检测结果">
        <div className="settings-runtime-header" aria-hidden="true">
          <span>工具</span>
          <span>说明</span>
        </div>
        {tools.map((tool) => (
          <div className="settings-runtime-item" data-status={tool.available ? "available" : "missing"} key={tool.id}>
            <span className="settings-runtime-main">
              <RuntimeToolIcon toolId={tool.id} />
              <span className="settings-runtime-name">{tool.label}</span>
            </span>
            <span className="settings-runtime-description">
              {tool.description}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function RuntimeToolIcon(props: { readonly toolId: string }): React.ReactElement {
  const iconSvg = resolveRuntimeToolIconSvg(props.toolId);
  return (
    <span className="settings-runtime-icon" aria-hidden="true">
      {iconSvg === undefined ? (
        <span className="settings-runtime-icon-fallback" />
      ) : (
        <span className="settings-runtime-icon-svg" dangerouslySetInnerHTML={{ __html: iconSvg }} />
      )}
    </span>
  );
}

function runtimeTools(tools: readonly RuntimeEnvironmentTool[] | undefined): readonly {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly executable?: string;
  readonly reason?: string;
  readonly available: boolean;
}[] {
  const detected = tools ?? [];
  if (detected.length === 0) {
    return [
      { id: "python", label: "Python", description: runtimeToolDescription("python"), available: false },
      { id: "node", label: "Node.js", description: runtimeToolDescription("node"), available: false },
      { id: "git-bash", label: "Git Bash", description: runtimeToolDescription("git-bash"), available: false },
    ];
  }
  const normalized = detected
    .map((tool, index) => {
      const id = tool.id ?? tool.label ?? `runtime-tool-${index}`;
      return {
        id,
        label: tool.label ?? tool.id ?? "Runtime",
        description: runtimeToolDescription(id, tool.description),
        executable: tool.executable,
        reason: tool.reason,
        available: tool.availability === "available",
      };
    });
  return normalized.sort((left, right) => runtimeToolRank(left.id) - runtimeToolRank(right.id));
}

function runtimeToolDescription(id: string, fallback?: string): string {
  if (id === "python") {
    return "通用编程语言，适用于脚本编写、自动化和数据处理";
  }
  if (id === "node") {
    return "基于 Chrome V8 引擎的 JavaScript 运行时，用于服务端开发";
  }
  if (id === "git-bash") {
    return "在 Windows 上提供 Git 和 Bash Shell 的类 Unix 命令行环境";
  }
  return fallback ?? "本机运行时工具";
}

function runtimeToolRank(id: string): number {
  if (id === "python") return 0;
  if (id === "node") return 1;
  if (id === "git-bash") return 2;
  return 10;
}