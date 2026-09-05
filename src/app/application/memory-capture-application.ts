import type { MemoryCaptureAcceptance, MemoryCaptureRuntime } from "../memory/index.js";
import type { OrdinaryAgentFeature } from "../ordinary-agent/index.js";

/**
 * Cross-feature Capture use case. PanelHost only publishes a stable Ordinary
 * run id; this application resolves the Ordinary-owned facts and invokes the
 * narrow Memory capture port in one place.
 */
export type MemoryCaptureApplication = {
  acceptStableRun(runId: string): Promise<MemoryCaptureAcceptance | undefined>;
};

export function createMemoryCaptureApplication(input: {
  readonly ordinary: Pick<OrdinaryAgentFeature, "queries">;
  readonly captureRuntime: MemoryCaptureRuntime;
  readonly onActivity?: (conversationId: string) => void;
}): MemoryCaptureApplication {
  return {
    async acceptStableRun(runId) {
      const facts = await input.ordinary.queries.getStableTerminalRunFacts(runId);
      if (facts === undefined) return undefined;
      const owner = await input.ordinary.queries.getConversationOwner(facts.turn.conversationId);
      if (owner === undefined) return undefined;
      const acceptance = await input.captureRuntime.acceptStableSignal({
        owner,
        conversationId: facts.turn.conversationId,
        stableThrough: {
          turnId: facts.turn.userTurnId,
          ordinal: facts.turn.ordinal,
          sourceRevision: facts.sourceRevision,
        },
      });
      input.onActivity?.(facts.turn.conversationId);
      return acceptance;
    },
  };
}
