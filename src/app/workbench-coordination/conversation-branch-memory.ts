import type { MemorySourceLifecyclePort, SupersedeConversationSourcesInput } from "../memory/index.js";

/** Retire the replaced source ranges; published recognition remains available as history. */
export function createConversationBranchMemoryCoordinator(
  memory: MemorySourceLifecyclePort,
): (input: SupersedeConversationSourcesInput) => Promise<void> {
  return input => memory.supersedeConversationSources(input);
}
