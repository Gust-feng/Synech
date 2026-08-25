import { spawnSync } from "node:child_process";

const eventName = process.env.EVENT_NAME;
const before = process.env.BEFORE_SHA;
const current = process.env.CURRENT_SHA;
const pullRequestBase = process.env.PR_BASE_SHA;
const pullRequestHead = process.env.PR_HEAD_SHA;

if (eventName === "pull_request" && pullRequestBase && pullRequestHead) {
  run(["diff", "--check", `${pullRequestBase}...${pullRequestHead}`]);
} else if (current) {
  if (before && !/^0+$/u.test(before) && commitExists(before)) {
    run(["diff", "--check", before, current]);
  } else {
    run(["diff-tree", "--check", "--root", "--no-commit-id", "-r", current]);
  }
} else {
  run(["diff", "--check"]);
  run(["diff", "--cached", "--check"]);
}

function commitExists(ref) {
  return spawnSync("git", ["cat-file", "-e", `${ref}^{commit}`], {
    cwd: process.cwd(),
    stdio: "ignore",
    windowsHide: true,
  }).status === 0;
}

function run(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
