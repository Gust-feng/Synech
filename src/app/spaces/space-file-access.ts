const SPACE_REFERENCE_ATTACHMENT_PREFIX = "space-reference:";
const SPACE_REFERENCE_WRITE_PREFIX = "write:space-reference:";
const SPACE_SCOPE_PREFIX = "scope:space:";

/** Stable run-context identities shared by Space grant creation and execution. */
export function spaceReferenceAttachmentId(referenceId: string): string {
  return `${SPACE_REFERENCE_ATTACHMENT_PREFIX}${referenceId}`;
}

export function spaceReferenceIdFromAttachmentId(value: string): string | undefined {
  if (!value.startsWith(SPACE_REFERENCE_ATTACHMENT_PREFIX)) return undefined;
  const referenceId = value.slice(SPACE_REFERENCE_ATTACHMENT_PREFIX.length);
  return referenceId.length === 0 ? undefined : referenceId;
}

export function spaceReferenceWritePermission(referenceId: string): string {
  return `${SPACE_REFERENCE_WRITE_PREFIX}${referenceId}`;
}

export function isSpaceReferenceWritePermission(value: string): boolean {
  return value.startsWith(SPACE_REFERENCE_WRITE_PREFIX);
}

/** Internal run-context owner fact added by the Host after request parsing. */
export function spaceScopePermission(spaceId: string): string {
  return `${SPACE_SCOPE_PREFIX}${spaceId}`;
}

export function spaceScopeIdFromPermissions(values: readonly string[]): string | undefined {
  const owners = [...new Set(values
    .filter((value) => value.startsWith(SPACE_SCOPE_PREFIX))
    .map((value) => value.slice(SPACE_SCOPE_PREFIX.length))
    .filter((value) => value.length > 0))];
  if (owners.length > 1) {
    throw new Error(`Run context contains multiple Space owners: ${owners.join(", ")}.`);
  }
  return owners[0];
}

/** Whether the permission set belongs to a Space-owned run (any Space owner). */
export function hasSpaceOwnerScope(values: readonly string[]): boolean {
  return values.some((value) => value.startsWith(SPACE_SCOPE_PREFIX));
}
