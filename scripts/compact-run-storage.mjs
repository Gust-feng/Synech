import path from "node:path";
import { resolveProductHome } from "../dist/platform/storage/product-home.js";
import { acquireProductHomeRuntimeLease } from "../dist/app/panel-server/product-home-runtime-lease.js";
import { compactOrdinaryRunStorage } from "../dist/app/ordinary-agent/file-system-repository.js";

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--home")) {
  throw new Error("Usage: pnpm compact:run-storage [--home <Product Home>]");
}
const productHome = resolveProductHome({ productHome: args[1] });
const lease = await acquireProductHomeRuntimeLease(productHome);
try {
  const backupRoot = path.join(productHome, "backups", `run-storage-${new Date().toISOString().replaceAll(":", "-")}`);
  const result = await compactOrdinaryRunStorage(path.join(productHome, "data", "agent"), backupRoot);
  console.log(JSON.stringify({ productHome, backupRoot: result.count === 0 ? undefined : backupRoot, ...result }, null, 2));
} finally {
  await lease.release();
}
