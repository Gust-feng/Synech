import { spawn as spawnChildProcess } from "node:child_process";

/**
 * Stops the complete process tree owned by one development child. Windows does
 * not propagate ChildProcess.kill() to descendants, so a watcher can otherwise
 * survive after its immediate Node wrapper has exited.
 */
export async function stopDevelopmentProcessTree(child, options = {}) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return;
  }

  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const treeKillSucceeded = await runWindowsTreeKill(child.pid, options.spawnProcess ?? spawnChildProcess);
    if (!treeKillSucceeded) {
      child.kill("SIGTERM");
    }
    return;
  }

  const signalProcess = options.signalProcess ?? process.kill;
  try {
    // Development children are detached on POSIX, so this reaches watchers'
    // descendants without relying on each CLI to forward SIGTERM itself.
    signalProcess(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function runWindowsTreeKill(pid, spawnProcess) {
  const taskkill = spawnProcess("taskkill", ["/pid", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  return new Promise((resolve) => {
    taskkill.once("error", () => resolve(false));
    taskkill.once("exit", (code) => resolve(code === 0 || code === 128));
  });
}
