export {
  WorkbenchCoordinationError,
  type AttachWorkspaceToSpaceInput,
  type SpaceKnowledgeDetachWorkflow,
  type WorkbenchCoordination,
  type WorkbenchCoordinationErrorCode,
} from "./contracts.js";
export { createWorkbenchCoordination } from "./workbench-coordination.js";
export {
  createSpaceReferenceUnlinkService,
  type SpaceReferenceUnlinkService,
} from "./space-reference-unlink.js";
export {
  createWorkspaceDeletionCoordinator,
  type WorkspaceDeletionCoordinator,
} from "./workspace-deletion-coordinator.js";
export {
  createSpaceConversationDeletionCoordinator,
  type SpaceConversationDeletionCoordinator,
} from "./space-deletion-coordinator.js";
export {
  createConversationLifecycleCoordinator,
  type ConversationLifecycleCoordinator,
} from "./conversation-lifecycle-coordinator.js";
export {
  CONVERSATION_LIFECYCLE_SCHEMA_VERSION,
  newConversationBirthRecord,
  newConversationDeleteRecord,
  type ConversationBirthPhase,
  type ConversationBirthRecord,
  type ConversationDeletePhase,
  type ConversationDeleteRecord,
  type ConversationLifecycleJournal,
  type ConversationLifecycleRecord,
} from "./conversation-lifecycle-journal-contract.js";
