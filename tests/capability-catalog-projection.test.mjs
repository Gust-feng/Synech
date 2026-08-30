import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cachedMcpToolCatalog,
  filteredMcpToolCatalog,
  mcpCatalogItemForServer,
} from "../dist/app/capability/mcp-capability-catalog.js";
import { projectSkillCatalogItem } from "../dist/app/capability/skill-capability-catalog.js";
import {
  capabilityAllowedToolNames,
  capabilityToolCatalogItem,
} from "../dist/app/capability/tool-capability-catalog.js";

test("Skill capability projection preserves hashes and filters unsafe metadata keys", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synech-skill-catalog-test-"));
  try {
    const skillPath = path.join(root, "SKILL.md");
    const resourcePath = path.join(root, "guide.md");
    await fs.writeFile(skillPath, [
      "---",
      "summary: Catalog summary",
      "allowed-tools:",
      "  - Read",
      "metadata:",
      "  stable: yes",
      "  sourcePath: hidden",
      "---",
      "# Body",
      "Use this skill.",
      "",
    ].join("\n"), "utf8");
    await fs.writeFile(resourcePath, "guide", "utf8");

    const projected = await projectSkillCatalogItem({
      id: "catalog-skill",
      name: "Catalog Skill",
      description: "Projects a skill.",
      enabled: true,
      sourcePath: skillPath,
      triggers: ["catalog"],
      sourceKind: "project",
      sourceRootId: "project:catalog",
      sourcePrecedence: 10,
      references: [resourcePath],
    });

    assert.equal(projected.validationStatus, "valid");
    assert.match(projected.contentHash, /^sha256:[a-f0-9]{64}$/u);
    assert.match(projected.bodyHash, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(projected.allowedTools, ["Read"]);
    assert.equal(projected.metadata.stable, "yes");
    assert.equal(projected.metadata.sourcePath, undefined);
    assert.equal(projected.resources[0].relativePath, "guide.md");
    assert.match(projected.resources[0].contentHash, /^sha256:[a-f0-9]{64}$/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("MCP catalog projection keeps protocol identities, exposure, and allowed tool order", () => {
  const server = mcpServer();
  const discovered = cachedMcpToolCatalog([server]);
  const exposed = filteredMcpToolCatalog(discovered, [server]);
  const projected = mcpCatalogItemForServer(server, discovered.tools, exposed.tools);

  assert.deepEqual(discovered.allowedTools, ["server__inspect"]);
  assert.deepEqual(exposed.allowedTools, ["server__inspect"]);
  assert.equal(projected.tools[0].protocolName, "inspect");
  assert.equal(projected.exposedTools[0].name, "server__inspect");
  assert.equal(projected.commandSummary, "node server.js [arg] [arg]");
  assert.deepEqual(capabilityAllowedToolNames({
    baseAllowedTools: ["Read", "SkillRead"],
    mcpAllowedTools: exposed.allowedTools,
    catalogOnlyAllowedTools: ["SubAgent"],
  }), ["Read", "server__inspect", "SubAgent"]);
});

test("tool capability projection keeps the stable contract hash and fields", () => {
  const projected = capabilityToolCatalogItem({
    name: "Read",
    displayName: "Read",
    displayDescription: "Read a file",
    description: "Read a file",
    inputSchema: { type: "object", properties: {} },
    category: "filesystem",
    categoryLabel: "Filesystem",
    riskLevel: "low",
    riskLabel: "Low",
    operationType: "read",
    operationLabel: "Read",
    requiresConfirmation: false,
    confirmationLabel: "No confirmation",
    scopes: ["agent-basic"],
    enabledByDefault: true,
    availability: "available",
  });

  assert.equal(projected.name, "Read");
  assert.equal(projected.enabled, true);
  assert.deepEqual(projected.scopes, ["agent-basic"]);
  assert.match(projected.definitionHash, /^sha256:[a-f0-9]{64}$/u);
});

function mcpServer() {
  return {
    serverId: "server",
    label: "Server",
    transport: "stdio",
    command: "node",
    args: ["server.js", "--token", "secret"],
    envSecretRefs: [],
    confirmationMode: "never",
    toolExposureMode: "selected",
    enabledTools: ["inspect"],
    autoApprovedTools: [],
    enabled: true,
    cachedTools: [{
      name: "inspect",
      description: "Inspect",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    }],
    toolsCachedAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}
