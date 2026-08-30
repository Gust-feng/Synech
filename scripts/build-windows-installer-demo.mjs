import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(process.execPath, [path.join(projectRoot, "scripts", "build-windows-installer-shell.mjs")], {
  cwd: projectRoot,
  // Review builds always use the single stable Demo filename. A suffix belongs
  // to isolated engineering builds and must not leak into the user-facing demo.
  env: { ...process.env, SYNECH_INSTALLER_DEMO: "1", SYNECH_INSTALLER_ARTIFACT_SUFFIX: "" },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
