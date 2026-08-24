const MANAGED_ATTACHMENT_REF_PREFIX = "uploaded-attachment:";

export function managedAttachmentRef(attachmentId: string): string {
  return `${MANAGED_ATTACHMENT_REF_PREFIX}${attachmentId}`;
}

export function managedAttachmentId(ref: string): string | undefined {
  return ref.startsWith(MANAGED_ATTACHMENT_REF_PREFIX)
    ? ref.slice(MANAGED_ATTACHMENT_REF_PREFIX.length) || undefined
    : undefined;
}
