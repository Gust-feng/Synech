import type {
  AppBootstrapState,
  AppConversationState,
  AppRunObservationState,
} from "./app-state-domains";
export type {
  AppBootstrapState,
  AppConversationState,
  AppRunObservationState,
} from "./app-state-domains";

export type AppState =
  & AppBootstrapState
  & AppConversationState
  & AppRunObservationState;

export function createInitialAppState(): AppState {
  return {
    skills: [],
    subAgents: [],
    conversations: [],
    transcriptNodes: [],
    transcriptNodesByRunId: {},
    events: [],
    busy: false,
  };
}
