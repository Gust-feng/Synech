# ADR 0016: Bound session replay work and keep diagnostics opt-in

Status: Accepted (unreleased v1)

## Context

A branch command reopens the same JSONL Session 10–12 times; each open replays the
entire transaction log. The client then discards the command response and fetches
the conversation again. Run snapshots also persist diagnostic histograms and a
second verbose capability resolution, even when developer mode is disabled.

## Decision

- Reuse Pi's Session implementation through a bounded, Host-owned idle Session
  pool in the existing Adapter. No new runtime or transcript store. Session access
  remains serialized per session, each writer generation retains its revocation
  fence, and closed generation handles cannot be used even when the underlying Pi
  handle is reused. Evict on external file revision change, timeout, deletion,
  capacity and Host shutdown. Never keep two writable handles for one file.
- Checkpoint resolution, branch position lookup and assistant text reads each use
  one scoped Session access; branch movement resolves its checkpoint on its own
  admitted writer instead of opening a separate reader.
- The client applies the authoritative branch command response immediately and
  hydrates missing historical activity separately. Cached activity for unchanged
  immutable runs is reused. Request epochs reject stale navigation responses.
- Detailed tool metrics are disabled by default. The UI sends an explicit run
  diagnostic opt-in only when developer mode is enabled. Freeze that opt-in in Run
  birth so a resumed run obeys the same policy. Token billing/usage and tool facts
  remain necessary operational facts.
- Do not persist the redundant capabilityResolution. Execution still resolves
  capabilities from the frozen contract; UI context size comes from that same
  frozen model capability. Live execution plans remain ephemeral.
- Persist Run birth once, separate from its mutable state, under the existing Run
  owner. The repository hydrates its public document contract; ordinary transitions
  only rewrite mutable state. The revision boundary remains snapshot.json and the
  birth file is committed before that first snapshot. Explicit offline maintenance
  creates originals before rewriting existing valid snapshots. No startup reset.
- Ordinary listing uses the maintained manifest normally; repair scans are explicit
  recovery operations, not selected by a magic query limit. Do not add a second
  database or parallel transcript owner for performance.

## Validation

Measure branch commands against an isolated copy of real local Session logs before
and after. Protect single-writer reuse, generation revocation, external file edits,
shutdown/deletion, immutable birth recovery and opt-in metrics with minimal existing
core scenarios. Report command latency separately from UI hydration; do not claim
network or filesystem writes are instantaneous.
