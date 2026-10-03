# ADR 0015: Keep run facts lean and edit conversations through Pi branches

Status: Accepted (unreleased v1)

## Decision

- Run model configuration excludes presentation images and configurations for other models. Built-in model icons remain UI assets resolved from model/provider identity. Preserve the selected model configuration, executable capability contracts, tool outcomes and recovery checkpoints.
- ADR 0016 supersedes the on-disk layout: split immutable birth and mutable snapshot while retaining the same public Run document and atomic revision boundary. Normalize the shared configuration DTO at the run boundary and serialize snapshots compactly. An explicit offline maintenance command may rewrite validated snapshots without changing semantic revisions; startup never rewrites or deletes historical data.
- Editing a user turn creates a new immutable Run on the same Conversation and Pi Session. The replacement names its source Run; the owner never changes. Pi owns the transcript tree, including retained prior entries. Restore the source Run's start checkpoint, including the empty root, and submit under the same conversation lock.
- Before moving the Session tip, persist a short branch-change intent in Conversation control. It records the new Run identity, target and original safe checkpoints, and prior retirement facts. Recovery commits the selected branch when the new Run exists, or restores the original branch when birth never committed. Retired Run identities prevent pre-entry terminal turns and old pending successors from reappearing; they do not copy Pi's tree.
- Reject editing while a run or terminal settlement is active. Submission retries must retain the same replacement target and input. Editing preserves the source turn's context attachments and uses the user's currently selected model. External effects already performed by old runs are never undone by a transcript branch change.
- Historical branch editing invalidates any claim that old derived conversation memory represents the selected transcript. WorkbenchCoordination fences old capture jobs and invalidates branch-derived Memory before selection. New capture excludes the retained prefix, preserving consent exclusions; a restored branch also starts new capture only after its retained tip. Do not silently inject an old branch summary.

## Consequences and validation

No Pi storage replacement, transcript copying, automatic Product Home reset, or unlimited-cache redesign is included. Validate branch root editing, repeated edit/retry, restart during branch selection, busy rejection and failed birth restoration with the existing lifecycle tests. Run storage maintenance must acquire the Product Home lease, preserve a recoverable backup and validate every target before writing.

## Message interaction and branch navigation

- Message actions use compact icons; the expanded editor uses distinct Cancel and Send buttons. Editing fills the reading column, grows with its text and retains the draft on failure. No permanent instructional copy in message editing.
- Derive alternate message versions from immutable Run predecessor/replacement identities. Switching a version restores its retained continuation through Pi checkpoints; do not clone transcript content.
- Persist only one previous branch tip for reversible undo/redo and a temporary branch-change intent. Explicit rollback selects a retained prefix and retires its suffix; undo restores the previous selection. Branch switching, editing and rollback use the same conversation lock, busy/settlement gate, derived-memory invalidation and recovery policy.

ADR 0017 supersedes the standalone rollback and undo/redo interaction policy above. Editing, explicit version selection and recovery retain the same Ordinary ownership and locking rules.
