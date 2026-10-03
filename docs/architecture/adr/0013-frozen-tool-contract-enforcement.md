# ADR 0013: Frozen Tool Contract Enforcement

Status: Accepted for unreleased v1

## Problem

The common security policy infers HTTP behavior from arbitrary `url` and `method`
input keys. That rejects valid MCP resource URIs and can misclassify unrelated
tool parameters. Lazy MCP executors also use cached schemas and effect hints
without reading the server's live tools on a new connection.

## Decision

- URI/protocol input validation belongs to its executor adapter. Common security
  does not treat every `url` field as a network destination.
- HttpRequest explicitly declares the `http_request` runtime hint. Only that
  contract permits common security to interpret HTTP method side effects. GET
  and HEAD preserve read behavior; write methods require confirmation unless
  the invocation was approved or the run permits bypass. MCP uses its own
  explicit effect and confirmation metadata.
- Lazy MCP reads and validates one live catalog per connection generation before
  exposing its client to executions. Concurrent callers share that initialization.
- The selected tool's schema, output schema and execution metadata must equal
  its frozen definition. Missing or changed tools produce a structured failure
  before remote execution. A run never silently adopts a replacement contract;
  refresh the catalog and submit a new run to freeze the current definition.
- Reconnection repeats catalog validation. Other tools' changes do not invalidate
  an unchanged selected tool. Server hints remain declarations, not proof that a
  malicious server will obey them; this decision does not claim such a guarantee.

## Scope And Recovery

No new owner, network protocol, data schema or compatibility layer. Existing
snapshots retain their frozen facts; an incompatible old run is rejected rather
than rewritten. No data reset, migration or automatic deletion is introduced.
Backend process and HTTP cancellation fixes preserve existing lifecycle states.

## Verification

MCP tests must reject schema/effect drift before a remote call, allow unchanged
contracts, share first catalog reads, and revalidate after reconnect. Security
tests must allow authorized non-HTTP MCP URIs while preserving HTTP write
approval and adapter URL rejection. Cancellation tests use actual interleavings.
