import type { MemoryOwner } from "../../../domain/memory/index.js";
import { MemoryError } from "../contracts.js";

/**
 * 由持久化 owner_key 还原 MemoryOwner（admission 复核用）；不认识的结构一律拒绝。
 * 独立成模块：content/control 仓储与提炼层共用，避免互相 import。
 */
export function memoryOwnerFromKey(ownerKey: string): MemoryOwner {
  if (ownerKey === "global") return { kind: "global" };
  const separatorIndex = ownerKey.indexOf(":");
  const kind = separatorIndex === -1 ? "" : ownerKey.slice(0, separatorIndex);
  const id = separatorIndex === -1 ? "" : ownerKey.slice(separatorIndex + 1);
  if ((kind === "space" || kind === "workspace") && id.length > 0) return { kind, id };
  throw new MemoryError("memory_invalid_owner", `Cannot parse memory owner key ${ownerKey}.`);
}
