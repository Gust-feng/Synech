import assert from "node:assert/strict";
import test from "node:test";

import { McpClientWrapper } from "../dist/adapters/mcp/mcp-client.js";
import { LazyMcpToolExecutorProvider } from "../dist/adapters/mcp/mcp-lazy-tool-provider.js";
import { McpManager } from "../dist/adapters/mcp/mcp-manager.js";

const tool = {
  name: "inspect",
  description: "Inspect the test fixture",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
};

test("MCP client leaves connected state on transport close and can reconnect once", async () => {
  const transports = [];
  const states = [];
  const client = new McpClientWrapper(clientConfig(), {
    transportFactory: () => {
      const transport = new FakeMcpTransport();
      transports.push(transport);
      return transport;
    },
  });
  client.subscribeConnectionState((state) => states.push(state));

  await Promise.all([client.connect(), client.connect()]);
  assert.equal(client.isConnected(), true);
  assert.equal(transports.length, 1);

  transports[0].crashClose();
  assert.equal(client.isConnected(), false);
  assert.equal(states.at(-1)?.connected, false);
  assert.match(states.at(-1)?.error?.message ?? "", /closed unexpectedly/u);

  await client.connect();
  assert.equal(client.isConnected(), true);
  assert.equal(transports.length, 2);
  assert.deepEqual(await client.callTool("inspect", {}), {
    content: [{ type: "text", text: "ok" }],
    structuredContent: undefined,
    isError: undefined,
  });
  await client.disconnect();
});

test("MCP transport errors invalidate the client and a failed recovery does not loop", async () => {
  const transports = [];
  const client = new McpClientWrapper(clientConfig(), {
    transportFactory: () => {
      const transport = transports.length === 0
        ? new FakeMcpTransport()
        : new FakeMcpTransport({ connectError: new Error("replacement unavailable") });
      transports.push(transport);
      return transport;
    },
  });

  await client.connect();
  transports[0].crashError(new Error("stdio child exited"));
  assert.equal(client.isConnected(), false);

  await assert.rejects(client.connect(), /replacement unavailable/u);
  assert.equal(client.isConnected(), false);
  assert.equal(transports.length, 2);
});

test("lazy MCP provider single-flights concurrent reconnects after a transport closes", async () => {
  const transports = [];
  let failNextConnection = false;
  const client = new McpClientWrapper(clientConfig(), {
    transportFactory: () => {
      const transport = new FakeMcpTransport({
        connectError: failNextConnection ? new Error("lazy replacement unavailable") : undefined,
      });
      failNextConnection = false;
      transports.push(transport);
      return transport;
    },
  });
  const provider = new LazyMcpToolExecutorProvider(
    { servers: [mcpServer()] },
    { createClient: () => client },
  );
  const executor = provider.getToolsForRegistry()[0];

  await executor.execute({}, executionContext("initial"));
  transports[0].crashClose();

  await Promise.all([
    executor.execute({}, executionContext("reconnect-a")),
    executor.execute({}, executionContext("reconnect-b")),
  ]);
  assert.equal(transports.length, 2);

  failNextConnection = true;
  transports[1].crashClose();
  const failedRecovery = await Promise.allSettled([
    executor.execute({}, executionContext("failed-a")),
    executor.execute({}, executionContext("failed-b")),
  ]);
  assert.deepEqual(failedRecovery.map((result) => result.status), ["rejected", "rejected"]);
  assert.equal(transports.length, 3);
  await provider.disconnectAll();
});

test("MCP manager reports disconnect immediately and single-flights the next tool-call recovery", async () => {
  const transports = [];
  let failNextConnection = false;
  const client = new McpClientWrapper(clientConfig(), {
    transportFactory: () => {
      const transport = new FakeMcpTransport({
        connectError: failNextConnection ? new Error("manager replacement unavailable") : undefined,
      });
      failNextConnection = false;
      transports.push(transport);
      return transport;
    },
  });
  const manager = new McpManager(
    { servers: [mcpServer()] },
    { createClient: () => client },
  );

  await manager.connectAll();
  assert.equal(manager.getServerStatuses().server, "connected");
  const executor = manager.getToolsForRegistry()[0];

  transports[0].crashClose();
  assert.equal(manager.getServerStatuses().server, "disconnected");
  assert.equal(manager.getServerRuntimeSnapshots()[0].status, "disconnected");

  await Promise.all([
    executor.execute({}, executionContext("manager-a")),
    executor.execute({}, executionContext("manager-b")),
  ]);
  assert.equal(transports.length, 2);
  assert.equal(manager.getServerStatuses().server, "connected");

  failNextConnection = true;
  transports[1].crashError(new Error("replacement process exited"));
  assert.equal(manager.getServerStatuses().server, "disconnected");
  const failedRecovery = await Promise.allSettled([
    executor.execute({}, executionContext("manager-failed-a")),
    executor.execute({}, executionContext("manager-failed-b")),
  ]);
  assert.deepEqual(failedRecovery.map((result) => result.status), ["rejected", "rejected"]);
  assert.equal(transports.length, 3);
  assert.equal(manager.getServerStatuses().server, "error");
  await manager.disconnectAll();
});

function clientConfig() {
  return {
    serverId: "server",
    transport: "stdio",
    command: "unused-in-test",
  };
}

function mcpServer() {
  return {
    serverId: "server",
    label: "Server",
    transport: "stdio",
    command: "unused-in-test",
    args: [],
    envSecretRefs: [],
    confirmationMode: "never",
    toolExposureMode: "all",
    enabledTools: [],
    autoApprovedTools: [],
    enabled: true,
    cachedTools: [tool],
    toolsCachedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function executionContext(invocationId) {
  return {
    callerAgentId: "agent",
    traceId: `trace-${invocationId}`,
    goalId: "goal",
    invocationId,
  };
}

class FakeMcpTransport {
  constructor(options = {}) {
    this.connectError = options.connectError;
    this.closed = false;
  }

  async start() {}

  async send(message) {
    if (message.method === "initialize" && this.connectError !== undefined) {
      throw this.connectError;
    }
    if (message.id === undefined) return;
    let result;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake-mcp", version: "1.0.0" },
        };
        break;
      case "tools/list":
        result = { tools: [tool] };
        break;
      case "tools/call":
        result = { content: [{ type: "text", text: "ok" }] };
        break;
      case "prompts/list":
        result = { prompts: [] };
        break;
      case "resources/list":
        result = { resources: [] };
        break;
      case "resources/templates/list":
        result = { resourceTemplates: [] };
        break;
      default:
        throw new Error(`Unexpected MCP request ${message.method}`);
    }
    queueMicrotask(() => this.onmessage?.({ jsonrpc: "2.0", id: message.id, result }));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  crashClose() {
    this.closed = true;
    this.onclose?.();
  }

  crashError(error) {
    this.onerror?.(error);
  }
}
