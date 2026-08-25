import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const productHome = await mkdtemp(path.join(os.tmpdir(), "synech-desktop-smoke-"));
try {
  const code = await run(process.execPath, [
    path.resolve("node_modules/electron/cli.js"),
    "dist/app/panel-desktop.js",
    "--home",
    productHome,
    "--port",
    "0",
    "--smoke",
  ]);
  if (code !== 0) process.exitCode = code;
} finally {
  await rm(productHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}
