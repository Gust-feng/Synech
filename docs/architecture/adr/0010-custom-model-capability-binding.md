# ADR 0010: Per-Model Capability Binding

> Status: Accepted
> Date: 2026-10-01
> ADR 0011 supersedes manual catalog references, unknown context defaults and
> product reasoning vocabulary. Other ownership and transport decisions stand.
> Supersedes: ADR 0004 connection-only lookup and prohibition of user settings;
> ADR 0005 transport selection for generic/custom connections

## Context

Custom gateways can serve models from several vendors and rename them. Removing
the Pi Provider form without replacing its connection-only lookup left otherwise
known models without image input, reasoning levels and context limits.

## Decision

- ConfigCenter owns `modelSettings` on each profile, keyed by the exact upstream
  model ID. Settings contain an optional Pi catalog reference and sparse user
  capability overrides. Discovery catalogs remain ID/name caches; refreshing
  or removing discovery rows never overwrites model settings.
- Automatic resolution first honors native/explicit connection scope, then
  matches exact catalog IDs for generic connections. A slash-delimited vendor
  prefix may be removed for a second exact match. No substring matching,
  version stripping, first ambiguous result, or address inference is allowed.
- Prefer the original vendor's catalog where its identity is explicit in the
  model ID. Otherwise accept equivalent candidates only; conflicting candidates
  remain unconfirmed and can be selected explicitly by the user.
- Keep upstream ID, connection/authentication and catalog identity separate.
  Generic connections retain their configured transport even when a catalog
  reference uses another API. Protocol-specific compatibility and reasoning
  encoding are reused only for the matching transport. Native connections keep
  Pi-owned stream/auth/filter/catalog behavior.
- Pi remains the sole automatic model fact source. User settings are explicit
  connection-local configuration, not confirmed Pi facts. Runtime capabilities
  and presentation resolve through the same policy, and each run freezes its
  effective settings. Context/output limits, image input, reasoning support and
  supported reasoning levels can be adjusted; reset removes those settings.
- Reasoning levels are Pi level names, not arbitrary JSON payload fields.
  Custom reasoning uses Pi-supported transport encodings, never a second
  request engine. Unsupported native encodings fail explicitly.
- Unknown models remain selectable without invented public capabilities.
  Positive user-specified values can enable their corresponding functionality.

## Ownership And Data

Add one serialized ConfigCenter command for per-model replacement/reset and one
HTTP adapter entry. Do not replace an entire profile from a stale UI snapshot.
This extends the unreleased version 1 target settings and frozen run schema,
without a migration chain, startup reset, or automatic deletion of user data.
Profile deletion naturally removes its settings; model-list changes do not.

## Verification

Protect mixed-vendor gateways, prefix matching, ambiguity, original request IDs,
configured transport, image delivery through Pi payloads, reasoning encoding,
profile isolation, concurrent model-setting updates, restart persistence and
discovery refresh preservation. Live gateway support remains separate from
local request-payload verification.
