import {
  parsePermissionBoundaryRef,
  serializePermissionBoundaryRef,
} from "../../domain/ordinary/index.js";

const SPACE_REFERENCE_ATTACHMENT_PREFIX = "space-reference:";

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
  return serializePermissionBoundaryRef({ kind: "space_reference_write", referenceId });
}

export function isSpaceReferenceWritePermission(value: string): boolean {
  return parsePermissionBoundaryRef(value)?.kind === "space_reference_write";
}

/** Internal run-context owner fact added by the Host after request parsing. */
export function spaceScopePermission(spaceId: string): string {
  return serializePermissionBoundaryRef({ kind: "space_scope", spaceId });
}

export function spaceScopeIdFromPermissions(values: readonly string[]): string | undefined {
  const owners = [...new Set(values
    .map(parsePermissionBoundaryRef)
    .filter((value): value is Extract<NonNullable<typeof value>, { readonly kind: "space_scope" }> => value?.kind === "space_scope")
    .map((value) => value.spaceId))];
  if (owners.length > 1) {
    throw new Error(`Run context contains multiple Space owners: ${owners.join(", ")}.`);
  }
  return owners[0];
}

/** Whether the permission set belongs to a Space-owned run (any Space owner). */
export function hasSpaceOwnerScope(values: readonly string[]): boolean {
  return values.some((value) => parsePermissionBoundaryRef(value)?.kind === "space_scope");
}
