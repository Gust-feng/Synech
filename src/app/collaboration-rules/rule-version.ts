import { createHash } from "node:crypto";
import type { CollaborationRuleVersion } from "./contracts.js";

export function collaborationRuleContentVersion(content: string): CollaborationRuleVersion {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}
