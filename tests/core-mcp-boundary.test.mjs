import assert from "node:assert/strict";
import test from "node:test";

import { McpCatalogLimitError } from "../dist/adapters/mcp/index.js";

test("MCP catalog limit errors remain structured", () => {
  const error = new McpCatalogLimitError("tools", "items", 11, 10);
  assert.equal(error.code, "mcp_catalog_limit_exceeded");
  assert.equal(error.catalogKind, "tools");
  assert.equal(error.observed, 11);
  assert.equal(error.limit, 10);
});
