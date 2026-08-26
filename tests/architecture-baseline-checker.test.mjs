import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const checker = path.resolve("scripts/check-architecture-baseline.mjs");

test("architecture checker rejects dependency, presentation, persistence, and canonical Application bypasses", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synech-baseline-checker-"));
  try {
    await write(directory, "scripts/architecture-baseline-allowlist.json", "[]");
    await write(directory, "docs/architecture/data-baseline.json", JSON.stringify({ migrationChecksums: {} }));
    await write(directory, "src/app/workspaces/index.ts", `
      export type Workspace = { id: string };
      export function createSqliteWorkspaceRepository() { return {}; }
    `);
    await write(directory, "src/app/shared/workspace-contracts.ts", `
      export type { Workspace } from "../workspaces/index.js";
    `);
    await write(directory, "src/app/spaces/example.ts", `
      import type { Workspace } from "../shared/workspace-contracts.js";
      export const workspace: Workspace = { id: "workspace-1" };
    `);
    await write(directory, "src/app/panel-server/request-handler.ts", `
      import { createSqliteWorkspaceRepository } from "../workspaces/index.js";
      export const repository = createSqliteWorkspaceRepository();
    `);
    await write(directory, "src/app/panel-server/custom-handler.ts", `
      import * as workspace from "../workspaces/index.js";
      export async function handleCustomRoute() {
        return workspace.createSqliteWorkspaceRepository();
      }
    `);
    await write(directory, "src/app/panel-server/http-utils.ts", `
      export class PanelHttpError extends Error {}
    `);
    await write(directory, "src/app/outside.ts", `
      import * as http from "./panel-server/http-utils.js";
      export const error = new http.PanelHttpError();
    `);
    await write(directory, "src/app/panel-ui/src/features/conversations/Alias.tsx", `
      export function state(item: { message: string }) {
        const copy = item.message;
        return copy === "思考中" ? "running" : "idle";
      }
    `);
    await write(directory, "src/app/personal-knowledge/sqlite-repository.ts", `
      export function read(value: string) {
        return JSON.parse(value) as { refId: string };
      }
    `);
    await write(directory, "src/app/spaces/space-tools.ts", `
      import { createFile } from "../local-filesystem/index.js";
      export async function bypass(options) {
        await options.spaces.commands.addReference({});
        return createFile("unsafe.txt");
      }
    `);
    await write(directory, "src/app/panel-server/spaces/space-routes.ts", `
      export async function handleSpaceRoute(feature) {
        return feature.commands.updateReferenceImageCaption({});
      }
    `);

    const result = await runChecker(directory);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /feature-cross-import/u);
    assert.match(result.stderr, /route-infrastructure-import/u);
    assert.match(result.stderr, /panel-http-error-outside-adapter/u);
    assert.match(result.stderr, /presentation-string-control/u);
    assert.match(result.stderr, /persistence-runtime-schema/u);
    assert.match(result.stderr, /canonical-application-bypass/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

function runChecker(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [checker], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
