import type { EffectiveMemoryAdmission } from "../contracts.js";

/** Admission observed before an asynchronous evidence read; publishing must compare it again. */
export type CapturePublication = {
  readonly policyRevision: string;
  readonly generation: number;
  readonly conversationGeneration: number;
};

export function capturePublicationMatches(
  admission: EffectiveMemoryAdmission,
  conversationGeneration: number,
  expected: CapturePublication,
): boolean {
  return admission.effective !== "off" &&
    admission.policyRevision === expected.policyRevision &&
    admission.generation === expected.generation &&
    conversationGeneration === expected.conversationGeneration;
}
