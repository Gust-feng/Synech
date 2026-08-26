export {
  inspectSpaceExternalSource,
  spaceExternalReferenceStatus,
  spaceExternalSourceStatus,
  type SpaceExternalReferenceStatus,
  type SpaceExternalSourceExpectation,
  type SpaceExternalSourceInspector,
  type SpaceExternalSourceSnapshot,
} from "./space-external-source.js";
export {
  SPACE_TREE_SCHEMA_VERSION,
  SpaceFeatureError,
  type Space,
  type SpaceEvent,
  type SpaceFeature,
  type SpaceFeatureErrorCode,
  type SpaceAddableReference,
  type SpaceDirectReference,
  type SpaceExternalFileReference,
  type SpaceOwnedAssetDeletionPort,
  type SpaceMovableTarget,
  type SpaceReference,
  type SpaceReferenceActorKind,
  type SpaceReferenceActorRecord,
  type SpaceReferenceAnnotation,
  type SpaceReferenceAnnotationInput,
  type SpaceReferenceAnnotationPatch,
  type SpaceReferenceImageCaption,
  type SpaceReferenceItem,
  type SpaceRepository,
  type SpaceSummary,
  type SpaceTarget,
  type SpaceTree,
  type SpaceTreeEntry,
  type SpaceTreeSnapshot,
} from "./contracts.js";
export { validateSpaceTreeSnapshot } from "./space-validation.js";
export { createSqliteSpaceRepository } from "./sqlite-repository.js";
export { createSpaceFeature, type CreateSpaceFeatureInput } from "./space-feature.js";
export {
  createFileSystemSpaceReferenceDeletionJournal,
  inspectFileSystemSpaceReferenceDeletionJournal,
  type SpaceReferenceDeletionJournalRecord,
  type SpaceReferenceDeletionJournalStore,
  type SpaceReferenceDeletionPhase,
  type SpaceReferenceDeletionTarget,
} from "./file-system-reference-deletion-journal.js";
export {
  createSpaceReferenceDeletionLifecycle,
  type SpaceReferenceDeletionDiagnostic,
  type SpaceReferenceDeletionFilePort,
  type SpaceReferenceDeletionLeasePort,
  type SpaceReferenceDeletionLifecycle,
  type SpaceReferenceDeletionTargetState,
} from "./space-reference-deletion.js";
export {
  validateSpaceReference,
  validateSpaceReferenceAnnotation,
  spaceReferenceAnnotationSchema,
} from "./space-validation.js";
export {
  createSpaceAddReferenceTool,
  createSpaceCreateTool,
  createSpaceDeleteTool,
  createConversationDeleteTool,
  createSpaceListTool,
  createSpaceMoveTool,
  createSpaceReadReferenceTool,
  createSpaceRemoveReferenceTool,
  createSpaceRenameTool,
  createSpaceRevocationOverlay,
  createSpaceToolRegistryContribution,
  createSpaceTools,
  createSpaceUnlinkReferenceTool,
  createSpaceUpdateReferenceAnnotationTool,
  spaceReferenceAnnotationModelView,
  spaceReferenceModelView,
  type SpaceReferenceAnnotationModelView,
  type SpaceReferenceModelView,
  type SpaceRevocationOverlay,
  type SpaceToolOptions,
} from "./space-tools.js";
export {
  canonicalSpacePathIdentity,
  resolveSpacePath,
  type SpacePathGrant,
  type SpacePathIdentity,
  type SpacePathResolution,
} from "./space-path-resolver.js";
export {
  createSpaceRunPathAuthorization,
  frozenSpacePathGrants,
  type CreateSpaceRunPathAuthorizationInput,
} from "./space-run-path-authorization.js";
export {
  hasSpaceOwnerScope,
  isSpaceReferenceWritePermission,
  spaceReferenceAttachmentId,
  spaceReferenceIdFromAttachmentId,
  spaceReferenceWritePermission,
  spaceScopeIdFromPermissions,
  spaceScopePermission,
} from "./space-file-access.js";
