export const SPACE_REFERENCE_CONTENT_APPLICATION_ERROR_CODES = [
  "space_reference_not_found",
  "space_reference_revoked",
  "space_reference_membership_changed",
  "space_reference_source_changed",
  "space_reference_caption_unavailable",
  "space_reference_image_caption_revision_conflict",
  "space_reference_content_unavailable",
  "space_reference_source_missing",
  "space_reference_source_replaced",
  "space_reference_not_editable",
  "space_reference_revision_conflict",
  "space_reference_read_failed",
  "space_reference_entry_exists",
  "space_reference_entry_mutation_unavailable",
  "space_reference_mutation_failed",
  "invalid_space_reference_path",
  "invalid_space_reference_name",
  "workspace_not_available",
  "invalid_managed_asset_input",
  "managed_asset_not_found",
  "managed_asset_not_editable",
  "managed_asset_caption_not_editable",
  "managed_asset_revision_conflict",
  "managed_asset_text_too_large",
  "managed_asset_caption_too_large",
] as const;

export type SpaceReferenceContentApplicationErrorCode =
  typeof SPACE_REFERENCE_CONTENT_APPLICATION_ERROR_CODES[number];

/** Transport-neutral failure shared by every Space Reference content adapter. */
export class SpaceReferenceContentApplicationError extends Error {
  readonly name = "SpaceReferenceContentApplicationError";

  constructor(
    readonly code: SpaceReferenceContentApplicationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function isSpaceReferenceContentApplicationErrorCode(
  code: string,
): code is SpaceReferenceContentApplicationErrorCode {
  return (SPACE_REFERENCE_CONTENT_APPLICATION_ERROR_CODES as readonly string[]).includes(code);
}
