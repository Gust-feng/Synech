export type RunCapabilityState<TCapabilityResolution> = {
  readonly capabilityResolution?: TCapabilityResolution;
  readonly capabilityResolutionRunId?: string;
};

export function nextRunCapabilityState<TCapabilityResolution>(
  previous: RunCapabilityState<TCapabilityResolution>,
  input: {
    readonly runId: string;
    readonly capabilityResolution?: TCapabilityResolution;
  }
): RunCapabilityState<TCapabilityResolution> {
  if (input.capabilityResolution !== undefined) {
    return {
      capabilityResolution: input.capabilityResolution,
      capabilityResolutionRunId: input.runId,
    };
  }
  if (previous.capabilityResolutionRunId === input.runId) {
    return {
      capabilityResolution: previous.capabilityResolution,
      capabilityResolutionRunId: previous.capabilityResolutionRunId,
    };
  }
  return {
    capabilityResolution: undefined,
    capabilityResolutionRunId: undefined,
  };
}
