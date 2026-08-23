import { runRealAiSmoke } from "./real-ai-smoke-runner.js";

const goal = process.argv.slice(2).join(" ").trim() || undefined;
const summary = await runRealAiSmoke(goal);

if (summary.status === "skipped") {
  console.log("Synech Ordinary Agent real AI smoke skipped");
} else if (summary.status === "failed") {
  console.log("Synech Ordinary Agent real AI smoke failed");
  process.exitCode = 1;
} else {
  console.log("Synech Ordinary Agent real AI smoke completed");
}

console.log(JSON.stringify(summary, null, 2));
