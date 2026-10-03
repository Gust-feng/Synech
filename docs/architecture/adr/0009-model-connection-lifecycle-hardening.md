# ADR 0009: Model Connection Lifecycle Hardening

> Status: Accepted
> Date: 2026-10-01
> Related: ADR 0008

## Decision

- ModelProviderAuthApplication owns interactive login sessions, cancellation,
  timeout and logout. PanelHost creates one instance with a product auth port;
  HTTP routes only parse, invoke and map responses. Pi auth construction and
  credential interpretation remain in the host adapter. No module registry
  or second OAuth engine is introduced.
- Credential publication has a synchronous cancellation boundary after all
  asynchronous identity checks and immediately before publication starts.
  Cancellation before this boundary rejects the write. Publication already
  started is awaited, so a late cancel cannot report cancelled after success.
- Login failures retain their cause at the application diagnostic boundary.
  UI and host diagnostics expose only allowlisted categories and numeric
  status, never raw provider messages, response bodies, authorization URLs
  or credentials.
- Missing built-in providers omit only the unavailable new-service template
  and emit a structured market warning. Existing connections and custom
  service creation remain available. Pi version/catalog alignment remains a
  build-time/core invariant.
- Progressive tool visibility selects its supported cost representation
  from the frozen actual model transport, including native connections.
  Anthropic estimates use its actual non-constrained tool schema shape;
  provider observations count the assembled request's actual definitions.
  Unknown wire formats keep all authorized tools visible.
- Nonempty model service addresses must be HTTP(S) URLs without embedded
  credentials. Empty addresses remain valid draft configuration. Invalid
  secret-store revision timestamps are explicitly rejected as corrupt data.

## Scope

No product-data version, migration chain, reset or credential-storage format
is added. Authentication routes and independent connection identities remain
unchanged. Tests protect cancellation/publication and existing request/tool
contracts, rather than UI details.
