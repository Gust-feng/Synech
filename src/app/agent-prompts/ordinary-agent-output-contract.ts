import type { ModelOutputContract } from "../../domain/intelligence/index.js";
import { ORDINARY_AGENT_OUTPUT_CONTRACT_ID } from "./ordinary-agent-identity.js";

export const ORDINARY_AGENT_OUTPUT_CONTRACT: ModelOutputContract = {
  contractId: ORDINARY_AGENT_OUTPUT_CONTRACT_ID,
  outputKind: "explanation",
  format: "text",
  minTextLength: 1,
  visibleOutput: {
    fields: ["text"],
    maxFieldLength: 128_000,
  },
};
