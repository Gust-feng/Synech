const PORTABLE_TOOL_NAME_PATTERN = /^[A-Za-z0-9_]+$/u;

/**
 * Freezes an external tool identifier into a provider-portable identity.
 * Adapters must retain the original protocol identifier separately when invoking the source.
 */
export function canonicalToolName(value: string): string {
  const canonical = value.replace(/[^A-Za-z0-9]/gu, "_");
  if (canonical.length === 0) {
    throw new Error("Tool name cannot be empty.");
  }
  return canonical;
}

export function canonicalNamespacedToolName(namespace: string, localName: string): string {
  return `${canonicalToolName(namespace)}__${canonicalToolName(localName)}`;
}

export function canonicalToolNamespacePrefix(namespace: string): string {
  return `${canonicalToolName(namespace)}__`;
}

export function isCanonicalToolName(value: string): boolean {
  return PORTABLE_TOOL_NAME_PATTERN.test(value);
}

export function assertCanonicalToolName(value: string): void {
  if (!isCanonicalToolName(value)) {
    throw new Error(
      `Tool ${JSON.stringify(value)} is not a canonical provider-portable name. ` +
      "Normalize external tool names before registration.",
    );
  }
}
