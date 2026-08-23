import type { ModelOutputKind } from "./model-output-contracts.js";

export type ModelCallRef = {
  readonly requestId: string;
  readonly responseId?: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly outputKind: ModelOutputKind;
  readonly eventRefs: readonly string[];
  readonly validationStatus: "pending" | "passed" | "failed";
};
