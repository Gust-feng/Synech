import type {
  ToolCategory,
  ToolDefinition,
  ToolDefinitionMetadata,
  ToolOperationType,
  ToolRiskLevel,
} from "./contracts.js";

export type ToolPresentation = {
  readonly displayName: string;
  readonly displayDescription: string;
  readonly categoryLabel: string;
  readonly operationLabel: string;
  readonly riskLabel: string;
  readonly confirmationLabel: string;
};

type ToolPresentationSeed = {
  readonly displayName: string;
  readonly displayDescription: string;
};

export type CommandTextLike = {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly commandLine?: string;
};

const BUILTIN_TOOL_PRESENTATION: Readonly<Record<string, ToolPresentationSeed>> = {
  ResearchSearch: {
    displayName: "资料搜索",
    displayDescription: "在已配置的信息源中检索资料，返回可引用的资料摘要。",
  },
  ResearchRead: {
    displayName: "资料读取",
    displayDescription: "读取检索结果或资料引用内容，用于补充上下文。",
  },
  WebSearch: {
    displayName: "网页搜索",
    displayDescription: "通过已配置的搜索服务获取外部网页资料摘要。",
  },
  WebFetch: {
    displayName: "浏览网页",
    displayDescription: "用独立浏览器会话打开网页并返回文本快照，不复用登录态。",
  },
  HttpRequest: {
    displayName: "HTTP 请求",
    displayDescription: "发送无状态 HTTP/HTTPS 请求并返回状态、响应头和有上限的响应体。",
  },
  Read: {
    displayName: "读取文件",
    displayDescription: "读取授权工作区内的文本文件，用于理解项目上下文。",
  },
  ReadOutput: {
    displayName: "读取工具结果",
    displayDescription: "按引用继续读取已保存的大工具结果，不会重新执行原工具。",
  },
  Glob: {
    displayName: "浏览目录",
    displayDescription: "查看工作区目录结构，帮助定位相关文件。",
  },
  Grep: {
    displayName: "搜索文件",
    displayDescription: "在本地工作区搜索文本，返回匹配文件、行号和片段。",
  },
  AttachmentList: {
    displayName: "查看附件",
    displayDescription: "列出本轮用户提供的上下文附件引用和元数据。",
  },
  AttachmentRead: {
    displayName: "读取附件文本",
    displayDescription: "按附件引用读取文本文件或附件项目中的文本文件。",
  },
  AttachmentReadPdf: {
    displayName: "读取附件 PDF 文本",
    displayDescription: "按附件引用从文本型 PDF 中尽力抽取正文，不处理 OCR。",
  },
  AttachmentReadImage: {
    displayName: "读取附件图片",
    displayDescription: "按附件引用把图片作为本轮模型视觉输入读取。",
  },
  AttachmentInspectTable: {
    displayName: "检查附件表格",
    displayDescription: "按附件引用识别 CSV/TSV/XLSX 表格列、行数、sheet 和样例行。",
  },
  AttachmentReadTable: {
    displayName: "读取附件表格",
    displayDescription: "按附件引用读取 CSV/TSV/XLSX 表格的指定行窗口。",
  },
  AttachmentInspectArchive: {
    displayName: "检查附件压缩包",
    displayDescription: "按附件引用列出 ZIP 压缩包内部条目，不解压文件。",
  },
  AttachmentListFiles: {
    displayName: "浏览附件目录",
    displayDescription: "按附件引用浏览用户提供的项目文件夹结构。",
  },
  AttachmentSearchFiles: {
    displayName: "搜索附件文件",
    displayDescription: "按附件引用在用户提供的文件或项目中搜索文本。",
  },
  Edit: {
    displayName: "编辑文件",
    displayDescription: "精确修改工作区文本文件，并返回变更摘要。",
  },
  Write: {
    displayName: "写入文件",
    displayDescription: "写入工作区文本文件。",
  },
  SkillRead: {
    displayName: "读取技能资源",
    displayDescription: "按本轮已选中技能读取参考资源或查看资源元数据。",
  },
  Shell: {
    displayName: "Shell 命令",
    displayDescription: "在当前会话 Shell 中运行命令，适合构建、测试、脚本和通用 CLI 工作流。",
  },
  ProcessRead: {
    displayName: "检查进程",
    displayDescription: "按稳定进程标识检查工作区受管进程的状态、端口和日志引用。",
  },
  ProcessStop: {
    displayName: "停止进程",
    displayDescription: "按稳定进程标识停止一个工作区受管进程。",
  },
  Agent: {
    displayName: "调用专家",
    displayDescription: "将一项边界清楚的任务交给已登记专家，并将结果返回当前 Agent。",
  },
  AgentSpawn: {
    displayName: "创建专家",
    displayDescription: "为当前任务创建一个受限的临时专家，并将结果返回当前 Agent。",
  },
};

export function toolPresentationForDefinition(definition: ToolDefinition): ToolPresentation {
  return toolPresentationForName(definition.name, definition.metadata, definition.description);
}

export function toolPresentationForName(
  name: string,
  metadata?: ToolDefinitionMetadata,
  description?: string
): ToolPresentation {
  const seed = BUILTIN_TOOL_PRESENTATION[name] ?? fallbackPresentation(name, metadata);
  return {
    displayName: seed.displayName,
    displayDescription: seed.displayDescription || description || "运行时工具。",
    categoryLabel: toolCategoryLabel(metadata?.category),
    operationLabel: toolOperationLabel(metadata?.operationType),
    riskLabel: toolRiskLabel(metadata?.riskLevel),
    confirmationLabel: metadata?.requiresConfirmation === true ? "需确认" : "可用",
  };
}

export function toolDisplayName(name: string, metadata?: ToolDefinitionMetadata): string {
  return toolPresentationForName(name, metadata).displayName;
}

export function commandDisplayText(display: CommandTextLike): string | undefined {
  if (typeof display.commandLine === "string" && display.commandLine.trim().length > 0) {
    return display.commandLine.trim();
  }
  const parts = [display.command, ...(display.args ?? [])]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return parts.length === 0 ? undefined : parts.join(" ");
}

export function commandTextFromValue(value: unknown, fallback?: unknown): string | undefined {
  const primary = asRecord(value);
  const secondary = asRecord(fallback);
  const commandLine =
    stringOrUndefined(primary.commandLine) ??
    stringOrUndefined(secondary.commandLine);
  if (commandLine !== undefined) {
    return commandLine;
  }
  const command =
    stringOrUndefined(primary.command) ??
    stringOrUndefined(secondary.command);
  if (command === undefined) {
    return undefined;
  }
  const primaryArgs = stringArray(primary.args);
  const args = primaryArgs.length > 0 ? primaryArgs : stringArray(secondary.args);
  return [command, ...args].join(" ").trim();
}

export function commandProgramFromValue(value: unknown, fallback?: unknown): string | undefined {
  const primary = asRecord(value);
  const secondary = asRecord(fallback);
  return stringOrUndefined(primary.command)
    ?? stringOrUndefined(secondary.command)
    ?? commandTextFromValue(primary, secondary);
}

export function toolCategoryLabel(category: ToolCategory | undefined): string {
  switch (category) {
    case "research":
      return "资料检索";
    case "workspace":
      return "工作区";
    case "filesystem":
      return "文件系统";
    case "terminal":
      return "终端命令";
    case "web":
      return "网页访问";
    case "mcp":
      return "扩展协议";
    case "other":
    case undefined:
      return "其他能力";
  }
}

export function toolOperationLabel(operation: ToolOperationType | undefined): string {
  switch (operation) {
    case "read-only":
      return "只读";
    case "read-write":
      return "读写";
    case "execute":
      return "执行";
    case "external-submit":
      return "外部提交";
    case undefined:
      return "未声明";
  }
}

export function toolRiskLabel(risk: ToolRiskLevel | undefined): string {
  switch (risk) {
    case "low":
      return "低风险";
    case "medium":
      return "中风险";
    case "high":
      return "高风险";
    case undefined:
      return "风险未声明";
  }
}

function fallbackPresentation(name: string, metadata: ToolDefinitionMetadata | undefined): ToolPresentationSeed {
  const displayName = fallbackToolDisplayName(name);
  if (metadata?.category === "filesystem") {
    return {
      displayName,
      displayDescription: "在工作区文件边界内读取或修改文件。",
    };
  }
  if (metadata?.category === "terminal") {
    return {
      displayName,
      displayDescription: "在工作区执行终端相关操作。",
    };
  }
  if (metadata?.category === "web" || metadata?.category === "research") {
    return {
      displayName,
      displayDescription: "读取或检索外部资料，并返回资料摘要。",
    };
  }
  if (metadata?.category === "mcp") {
    return {
      displayName,
      displayDescription: "由外部扩展协议提供的工具能力。",
    };
  }
  return {
    displayName,
    displayDescription: "运行时工具。",
  };
}

function fallbackToolDisplayName(name: string): string {
  const segments = name.trim().split("__").filter((segment) => segment.length > 0);
  const leaf = segments.at(-1) ?? name;
  const normalized = leaf
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length === 0 ? "工具" : normalized;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
