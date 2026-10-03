# ADR 0007: Model Service Connection Presets

> Status: Accepted
> Date: 2026-09-30
> Related: ADR 0004, ADR 0005
> Native connection support and grouped presentation superseded by ADR 0008

## Context

The settings market grouped Pi providers by brand. Distinct regional,
subscription and Coding endpoints were folded into one preset, while the
runtime provider field was exposed to users to compensate. Removing that
internal field must not make those supported endpoints inaccessible.

An icon is only brand artwork, not evidence of a connectable service. Pi's
installed catalog remains the source for providers, models and transport facts.

## Initial Decision

- List one preset per connectable Pi provider. Keep the five existing built-in
  slots and the existing primary brand preset IDs unchanged.
- Give other connections explicit names such as Kimi Coding, international
  MiniMax and regional Token Plan connections. Each preset carries exactly one
  internal `piProviderId`; users do not enter it.
- Provider-level Base URL wins. If Pi has no provider-level URL, use a unique
  model Base URL for the selected default transport. Never synthesize an
  endpoint or choose an arbitrary URL when there are multiple candidates.
- Only the three transports already served by the product are eligible.
  No provider is downgraded to a different protocol to make it appear supported.
- Cloudflare Gateway/Workers and GitHub Copilot are not offered as ready
  templates until their provider-specific setup and request handling are
  integrated. A supported model API alone is insufficient.
- Keep existing saved connections intact, including connections no longer
  offered as new templates. Do not delete, merge or migrate settings.
- A provider absent from Pi is not added based on an icon. Its models can still
  be supplied by supported gateways or explicit custom endpoints.

## Scope And Verification

This changes market projection, not model facts, data format, runtime auth,
transport ownership or persisted profile identities. OAuth and new protocols
are separate integration work.

Verify exact provider coverage, unique preset IDs, factual nonempty URLs,
automatic internal bindings and preservation of custom connections.
No live-provider availability claim is made without real request acceptance.
