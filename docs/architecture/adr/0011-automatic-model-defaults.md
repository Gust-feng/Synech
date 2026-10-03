# ADR 0011: Automatic Model Defaults And Product Reasoning Levels

> Status: Accepted
> Date: 2026-10-01
> Supersedes: ADR 0010 manual catalog references and unrestricted product levels

## Decision

- Standard-model resolution is automatic. Keep native/explicit provider scope,
  exact ID matching and ambiguity handling from ADR 0010. After an exact miss,
  remove slash-delimited prefixes from the left, preferring the longest remaining
  exact catalog ID; retain namespaces belonging to the catalog ID.
  Remove manual catalog references from the UI, API and target settings schema.
  Unmatched models can be configured directly in advanced settings.
- Context windows resolve as user override, confirmed Pi value, then the product
  default of 256,000 tokens (256K). This default is an operating budget, not a
  confirmed model capability. UI, tool budgets and Pi runtime use the same value.
  Unknown image/reasoning support and output limits are not invented.
- Advanced settings display the effective numeric values. Saving unchanged
  defaults does not copy catalog values into durable settings. Reset removes
  overrides and immediately displays automatic values again.
- Product reasoning choices are `low`, `medium`, `high`, `xhigh`, `max`, labeled
  低、中、高、极高、最高. Only a model's supported subset is selectable.
  Raw Pi facts and transport maps retain Pi's `off` and `minimal` entries, but
  neither is a product choice. Absence continues to express no requested effort.
- Remove the now-unused full standard-model catalog from the settings response.
  Service discovery and native model catalogs are unchanged.

## Data And Verification

Directly maintain the unreleased v1 target schema; do not add a migration chain,
reset user data or change the version. Obsolete references and explicit minimal
level overrides are rejected by schema validation.

Use existing core configuration, persistence and Pi payload tests to verify
automatic matching, sparse overrides, unknown-model budgets, supported product
levels, reset and preservation of original upstream IDs.
