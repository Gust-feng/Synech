import { createHash } from "node:crypto";

import type { AgentNoteVersion } from "./contracts.js";

export function agentNoteContentVersion(content: string): AgentNoteVersion {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}
