# ADR 0017: Use message editing and version selection without standalone rollback actions

Status: Accepted (unreleased v1)
Date: 2026-10-02

## Decision

- Remove the assistant message's rollback-to-turn action and the user message's branch undo/redo action. Message editing and explicit previous/next version selection are the supported ways to revise a Conversation.
- Remove their frontend commands, HTTP routes and Ordinary public commands. Version selection accepts one required target Run identity; no rollback distance or turn-identity alias is accepted.
- Keep immutable Run history, alternate versions, attachments, Pi checkpoints, the conversation lock, settlement gate, derived-memory invalidation and pending-branch recovery. Version selection restores the selected message's retained continuation instead of truncating it.
- The Conversation control storage schema is unchanged. Existing previous-selection fields and recovery intents remain internal control facts, without advertising undo/redo through read models or creating a new storage format. Do not reset or rewrite Product Home as part of this interaction change.
- This supersedes ADR 0015's standalone rollback and reversible undo/redo interaction policy. It does not remove runtime checkpoint restoration or failure compensation.

## Validation

Update the existing branch lifecycle scenario to switch explicitly between original and edited versions after restart, verifying retained continuation and checkpoints. Keep failed-edit birth recovery and pending-selection recovery coverage. Check frontend and backend types, Panel build, architecture baseline and whitespace.
