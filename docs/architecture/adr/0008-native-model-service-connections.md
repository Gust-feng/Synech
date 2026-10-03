# ADR 0008: Native Model Service Connections

> Status: Accepted
> Date: 2026-09-30
> Supersedes: ADR 0007 transport eligibility and flat directory presentation
> Related: ADR 0003, ADR 0004, ADR 0005, ADR 0006
> Lifecycle placement, publication boundary and partial market failure clarified by ADR 0009.

## Context

One brand can expose multiple API, regional, cloud and subscription services.
A flat endpoint directory duplicates brands and asks users to understand
runtime details. Custom endpoints are a primary workflow, not an exceptional
fallback. Pi already owns native provider streams, authentication, model
filtering and dynamic catalogs; rebuilding those mechanisms would create
another source of truth.

## Decision

- Present custom service creation as a direct, prominent action. Preserve the
  existing compatible Chat Completions, Responses and Messages connections,
  editable addresses and manually entered model IDs.
- Group templates by brand/platform, then select a concrete service plan.
  Grouping is presentation only: every saved connection retains its own
  profile identity, settings, credential and model selection. Multiple
  connections to the same service are allowed.
- Add an explicit native connection mode. The Pi adapter selects the declared
  native provider factory and retains its request, authentication, model
  availability and refresh behavior. No native API is silently replaced by a
  compatible protocol. Internal provider IDs are not user configuration.
- Connection settings contain only non-secret service parameters and an
  explicit authentication mode. API keys and OAuth credentials remain in
  the existing secret-store boundary, isolated per profile. Ordinary config
  responses and model catalogs must never include credentials.
- Provider-owned login, token refresh and ambient credentials are reused from
  installed Pi. Synech owns the interaction lifecycle, cancellation and safe
  persistence. A deleted connection or cancelled/replaced login cannot
  publish a stale credential.
- Native model discovery uses the actual provider registry, availability
  filter and refresh operation. A native service is not assumed to expose
  `/models` or require an API key. Dynamic model facts remain Pi-owned.
- Dynamic facts retain a reference to the actual Pi registry, scoped by
  profile, service parameters and secret revision. Model selection and labels
  do not change that scope. Secret-store timestamps are strictly monotonic
  across writes and deletion/recreation; this adds no schema version or
  credential data to public responses.
- Installed Pi is the sole runtime/model fact source. Brand/service labels
  and form requirements are product presentation, not alternative model
  definitions or capability overrides.

## Data And Ownership

ConfigCenter remains the profile/settings owner; its existing secret-store
port owns secret persistence. Credential slots are scoped per profile and per
authentication kind: switching a connection's authentication mode preserves
both the API key and OAuth credentials, and a mode without its own credential
reports unconfigured instead of destroying the other slot. This extends the
unreleased v1 target settings, not the SQLite owner schema or a compatibility
migration chain. No startup reset, automatic deletion or profile merging is
introduced.

The existing Agent Runtime Port remains the only product runtime boundary.
Pi credentials, APIs and provider objects stay inside adapters. No second
runtime, OAuth implementation or model-definition table is added.

## Verification

Verify generic/custom connection behavior, exact installed-provider coverage,
profile isolation, credential redaction, cancelled/deleted login publication,
and native binding/catalog construction. Run scoped core checks and the
repository verification gate. Configuration verification is not evidence of
successful requests with a real subscription or cloud account; report that
acceptance separately.
