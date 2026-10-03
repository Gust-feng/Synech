# ADR 0014: Assemble run capabilities together and recover through Pi-owned state

Status: Accepted (unreleased v1)

## Context

Per-run model overrides currently replace the model after the tool catalog has
already been assembled. Cancellation cleanup can finish its task with a failed
Session finalization, while conversation deletion subsequently removes the Run
facts needed to retry. Pi persists tool outcomes as pending entries before placing
them in the active transcript; recovery must account for both locations.

## Decision

- Select the effective model before assembling a run capability snapshot. Model
  capabilities and tool availability are frozen together; changing the selected
  model for a new run does not reuse the global model's tool availability.
- Add `ViewImage` for authorized workspace files. Reuse the existing workspace
  read authorization, mutation lock, image MIME policy, size limit and explicit
  tool attachment contract; `Read` remains a text reader.
- Output settings remain optional. Known models use Pi catalog values. Unknown
  Anthropic-compatible models use a 4,096-token request budget unless explicitly
  overridden. This is a product request default, not a confirmed model limit.
  Unknown OpenAI-compatible transports retain their existing omission policy.
- Before deleting any Run evidence, conversation cleanup must finalize its live
  Session control and settle accepted results. On failure it retains the Run and
  attachments for the same cleanup to retry. Deleting unrelated sessions is not
  blocked. Preserve the existing tombstone and explicit deletion semantics.
- Recover missing image-bearing transcript entries from Pi's own pending entries,
  proving assistant tool-call identity, canonical text, status and image hashes.
  Do not reexecute tools or create a second image store. Validate the complete
  recovery group before moving the active tip.
- Unsent attachment drafts remain instance-local and are cleaned on exit or the
  next startup. No draft persistence or compatibility layer is introduced.
- A managed upload is claimed for its live Conversation before its Run snapshot
  is published. If the process exits in that birth window, a non-deleted
  Conversation remains the durable owner signal and recovery preserves the
  claimed upload instead of treating it as an orphan. Conversation cleanup
  remains responsible for deleting it later.
- Ordinary's resident Run documents also drive conversation visibility, turn
  order and submission idempotency; they are not disposable display caches.
  Background evidence reads and usage statistics must not evict these documents.
  Cache release only releases rebuildable activity projections. Keep the existing
  startup-owned Run index; do not add a second index or scan all stored Runs on
  every conversation query. Session deletion is idempotent for a missing Session,
  while malformed identity, metadata and active writers remain errors.
- Capturing an empty starting leaf is not a Session write. A terminal Run stopped
  before its first entry remains a visible product turn, including `started` with
  a null start checkpoint. Runs sharing a Session position use product ordinal
  as the tie-breaker; rollback's pre-entry retirement guard uses the same rule.
  Once a later turn writes to the Session, retain its predecessor chain of
  pre-entry terminal turns as well. Only ancestors of the selected branch and
  its pending successors are visible; do not restore retired transcript branches.

## Validation and consequences

Protect actual model-switch assembly, authorized workspace image delivery,
retryable deletion after release failure and Pi pending-image recovery with minimal
core scenarios. Text pagination remains supported; unify file and attachment line
semantics rather than adding a second paginator. No durable schema changes,
automatic resets, startup replay or external-file deletion are introduced.
