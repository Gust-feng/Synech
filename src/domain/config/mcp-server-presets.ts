import type { UpsertMcpServerInput } from "./contracts.js";

export type McpServerPreset = {
  readonly presetId: string;
  readonly label: string;
  readonly description: string;
  readonly server: UpsertMcpServerInput;
};

export function listBuiltinMcpServerPresets(): readonly McpServerPreset[] {
  return [
    {
      presetId: "filesystem",
      label: "Filesystem",
      description: "Local filesystem MCP server template.",
      server: {
        serverId: "filesystem",
        label: "Filesystem",
        transport: "stdio",
        commandLine: "npx -y @modelcontextprotocol/server-filesystem .",
        confirmationMode: "never",
        toolExposureMode: "none",
        enabled: false,
      },
    },
    {
      presetId: "browser",
      label: "Browser",
      description: "Playwright browser automation MCP server template.",
      server: {
        serverId: "browser",
        label: "Browser",
        transport: "stdio",
        commandLine: "npx -y @playwright/mcp@latest",
        confirmationMode: "never",
        toolExposureMode: "none",
        enabled: false,
      },
    },
    {
      presetId: "github",
      label: "GitHub",
      description: "GitHub MCP server template; configure a token secret before use.",
      server: {
        serverId: "github",
        label: "GitHub",
        transport: "stdio",
        commandLine: "npx -y @modelcontextprotocol/server-github",
        envSecretRefs: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
        confirmationMode: "never",
        toolExposureMode: "none",
        enabled: false,
      },
    },
    {
      presetId: "fetch",
      label: "Fetch",
      description: "HTTP fetch MCP server template.",
      server: {
        serverId: "fetch",
        label: "Fetch",
        transport: "stdio",
        commandLine: "uvx mcp-server-fetch",
        confirmationMode: "never",
        toolExposureMode: "none",
        enabled: false,
      },
    },
    {
      presetId: "memory",
      label: "Memory",
      description: "Local memory MCP server template.",
      server: {
        serverId: "memory",
        label: "Memory",
        transport: "stdio",
        commandLine: "npx -y @modelcontextprotocol/server-memory",
        confirmationMode: "never",
        toolExposureMode: "none",
        enabled: false,
      },
    },
  ];
}
