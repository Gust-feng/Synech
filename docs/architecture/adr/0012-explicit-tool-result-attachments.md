# ADR 0012: Explicit Tool Result Attachments

Status: Accepted for unreleased v1

## Problem

Tool model attachments are currently stored on a non-enumerable Symbol inside
the JSON output. Object spread, structuredClone and JSON normalization can drop
that carrier while preserving an independently written attachment-success label.
Every output transform consequently needs a special attachment-copy operation.

## Decision

- `ToolCallResult` remains the durable execution fact. `ToolExecutionResult`
  extends it with explicit, enumerable `modelAttachments` for live delivery.
- Image and MCP executors return an explicit `ToolExecutorOutput` containing
  business `output` and model attachments. Existing text-only tools retain their
  plain JSON output; explicit executor failures may include live attachments.
- ToolCenter validates and detaches these two fields separately. Retention and
  preview fitting transform only `output`; ordinary copies retain attachments.
- Product contracts use the existing provider-neutral ModelInputAttachment;
  Pi types stay inside the adapter. Pi translates media content to each protocol.
- Pi Session owns durable image bytes. Before product acceptance, final outcome,
  or Pi result details, the adapter explicitly projects the durable ToolCallResult
  without live attachments. The existing `modelAttachmentRefs` remains the Run
  ledger's evidence for Session reconciliation. No second binary store is added.
- Attachment delivery labels are removed from executor business outputs. The
  model receives actual media blocks, rather than a separately maintained promise
  that an attachment exists. Explicit unsupported-content errors remain intact.

## Alternatives

Keeping Symbol copy helpers preserves a recurring omission hazard. Making those
Symbols enumerable does not make JSON serialization or structuredClone preserve
them. A hash-indexed side store adds lifecycle and recovery ownership without
being necessary for this problem. Neither alternative is selected.

## Scope And Recovery

This changes an in-process tool contract, not an HTTP command, owner, cancellation
state machine, SQLite schema, Run snapshot schema or Pi Session format. Target
data baseline stays unchanged; no migration, reset or startup deletion occurs.
Existing durable image refs and Session payloads remain authoritative on recovery.
An old live executor must be rebuilt; there is no hidden-carrier compatibility
path. Binary inputs must not enter Panel DTOs, output retention files or Run JSON.

## Verification

Protect actual delivery through ToolCenter, retention and Pi; ordinary result
copies; explicit failed MCP results with images; text-only model behavior; durable
projection and Session reconciliation. Tests target those boundaries, not each
helper. Architecture and build gates must pass.

## References

Codex uses explicit content items and independent log projection; its text output
truncation preserves image items. Reference revision:
`f70810bcd210ed780a3da5940e9e60f74ac8ee60`.

- https://github.com/openai/codex/blob/f70810bcd210ed780a3da5940e9e60f74ac8ee60/codex-rs/core/src/tools/handlers/view_image.rs
- https://github.com/openai/codex/blob/f70810bcd210ed780a3da5940e9e60f74ac8ee60/codex-rs/utils/output-truncation/src/lib.rs
