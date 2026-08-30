import type {
  InstallActivityPayload,
} from "./host";

export type InstallActivityRecord = InstallActivityPayload;

export type InstallActivityState = {
  readonly current?: InstallActivityRecord;
  readonly recent?: InstallActivityRecord;
};

export function createInstallActivityState(): InstallActivityState {
  return {};
}

export function reduceInstallActivity(
  state: InstallActivityState,
  activity: InstallActivityPayload,
): InstallActivityState {
  const next: InstallActivityRecord = {
    id: activity.id,
    kind: activity.kind,
    state: activity.state,
    objects: activity.objects,
  };

  if (state.current?.id === next.id) {
    return { ...state, current: next };
  }

  return {
    current: next,
    ...(state.current === undefined ? {} : { recent: state.current }),
  };
}
