import { runRealAiSmoke } from "./real-ai-smoke-runner.js";

const args = parseRealAiSmokeArgs(process.argv.slice(2));
const summary = await runRealAiSmoke(args.goal, { productHome: args.productHome });

if (summary.status === "skipped") {
  console.log("Synech Agent real AI smoke skipped");
} else if (summary.status === "failed") {
  console.log("Synech Agent real AI smoke failed");
  process.exitCode = 1;
} else {
  console.log("Synech Agent real AI smoke completed");
}

console.log(JSON.stringify(summary, null, 2));

function parseRealAiSmokeArgs(argv: readonly string[]): { readonly goal?: string; readonly productHome?: string } {
  const goalParts: string[] = [];
  let productHome: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--home") {
      productHome = requireValue(argv[index + 1], "--home");
      index += 1;
    } else if (arg.startsWith("--home=")) {
      productHome = requireValue(arg.slice("--home=".length), "--home");
    } else {
      goalParts.push(arg);
    }
  }
  const goal = goalParts.join(" ").trim();
  return { productHome, goal: goal.length === 0 ? undefined : goal };
}

function requireValue(value: string | undefined, flag: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) throw new Error(`${flag} requires a value.`);
  return normalized;
}
