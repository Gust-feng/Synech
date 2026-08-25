/** True for standing resources injected by the conversation Owner. */
export function isConversationOwnerContextRef(
  ref: { readonly automaticSpaceReference?: boolean },
): boolean {
  return ref.automaticSpaceReference === true;
}

export type ContextReferenceKind = "user_goal" | "workspace" | "file" | "project" | "web" | "runtime";

export type ParsedContextReference =
  | { readonly scheme: "local_file"; readonly path: string }
  | { readonly scheme: "local_project"; readonly path: string }
  | { readonly scheme: "uploaded_attachment"; readonly attachmentId: string }
  | { readonly scheme: "workspace"; readonly value: string }
  | { readonly scheme: "file"; readonly path: string }
  | { readonly scheme: "project"; readonly path: string }
  | { readonly scheme: "web"; readonly value: string }
  | { readonly scheme: "http_url"; readonly url: string };

export type ParsedPermissionBoundaryRef =
  | { readonly kind: "access"; readonly mode: "read" | "execute" | "deny" | "ask"; readonly target: string }
  | { readonly kind: "space_scope"; readonly spaceId: string }
  | { readonly kind: "space_reference_write"; readonly referenceId: string };

export function parseContextReference(
  ref: string,
  kind?: ContextReferenceKind,
): ParsedContextReference | undefined {
  const value = ref.trim();
  const lower = value.toLowerCase();
  const parsed = lower.startsWith("local-file:")
    ? nonEmptyPath("local_file", value.slice("local-file:".length))
    : lower.startsWith("local-project:")
      ? nonEmptyPath("local_project", value.slice("local-project:".length))
      : lower.startsWith("uploaded-attachment:")
        ? nonEmptyValue("uploaded_attachment", "attachmentId", value.slice("uploaded-attachment:".length))
        : lower.startsWith("workspace:")
          ? nonEmptyValue("workspace", "value", value.slice("workspace:".length))
          : lower.startsWith("file:")
            ? nonEmptyPath("file", value.slice("file:".length))
            : lower.startsWith("project:")
              ? nonEmptyPath("project", value.slice("project:".length))
              : lower.startsWith("web:")
                ? nonEmptyValue("web", "value", value.slice("web:".length))
                : lower.startsWith("http://") || lower.startsWith("https://")
                  ? { scheme: "http_url" as const, url: value }
                  : undefined;
  return parsed !== undefined && contextReferenceMatchesKind(parsed, kind) ? parsed : undefined;
}

export function serializeContextReference(ref: ParsedContextReference): string {
  switch (ref.scheme) {
    case "local_file": return `local-file:${ref.path}`;
    case "local_project": return `local-project:${ref.path}`;
    case "uploaded_attachment": return `uploaded-attachment:${ref.attachmentId}`;
    case "workspace": return `workspace:${ref.value}`;
    case "file": return `file:${ref.path}`;
    case "project": return `project:${ref.path}`;
    case "web": return `web:${ref.value}`;
    case "http_url": return ref.url;
  }
}

export function parsePermissionBoundaryRef(value: string): ParsedPermissionBoundaryRef | undefined {
  const ref = value.trim();
  if (ref.startsWith("scope:space:")) {
    const spaceId = ref.slice("scope:space:".length);
    return spaceId.length === 0 ? undefined : { kind: "space_scope", spaceId };
  }
  if (ref.startsWith("write:space-reference:")) {
    const referenceId = ref.slice("write:space-reference:".length);
    return referenceId.length === 0 ? undefined : { kind: "space_reference_write", referenceId };
  }
  for (const mode of ["read", "execute", "deny", "ask"] as const) {
    const prefix = `${mode}:`;
    if (!ref.startsWith(prefix)) continue;
    const target = ref.slice(prefix.length);
    return target.length === 0 ? undefined : { kind: "access", mode, target };
  }
  return undefined;
}

export function parseUserPermissionBoundaryRef(value: string): ParsedPermissionBoundaryRef | undefined {
  const parsed = parsePermissionBoundaryRef(value);
  return parsed?.kind === "access" ? parsed : undefined;
}

export function serializePermissionBoundaryRef(ref: ParsedPermissionBoundaryRef): string {
  if (ref.kind === "space_scope") return `scope:space:${ref.spaceId}`;
  if (ref.kind === "space_reference_write") return `write:space-reference:${ref.referenceId}`;
  return `${ref.mode}:${ref.target}`;
}

function contextReferenceMatchesKind(
  ref: ParsedContextReference,
  kind: ContextReferenceKind | undefined,
): boolean {
  if (kind === undefined) return true;
  if (kind === "file") return ref.scheme === "local_file" || ref.scheme === "uploaded_attachment" || ref.scheme === "file" || ref.scheme === "workspace";
  if (kind === "project") return ref.scheme === "local_project" || ref.scheme === "project" || ref.scheme === "workspace";
  if (kind === "web") return ref.scheme === "web" || ref.scheme === "http_url";
  if (kind === "workspace") return ref.scheme === "workspace";
  return false;
}

function nonEmptyPath<S extends "local_file" | "local_project" | "file" | "project">(
  scheme: S,
  path: string,
): Extract<ParsedContextReference, { readonly scheme: S }> | undefined {
  return path.length === 0 ? undefined : { scheme, path } as Extract<ParsedContextReference, { readonly scheme: S }>;
}

function nonEmptyValue<
  S extends "uploaded_attachment" | "workspace" | "web",
  K extends S extends "uploaded_attachment" ? "attachmentId" : "value",
>(scheme: S, key: K, value: string): Extract<ParsedContextReference, { readonly scheme: S }> | undefined {
  return value.length === 0
    ? undefined
    : { scheme, [key]: value } as Extract<ParsedContextReference, { readonly scheme: S }>;
}
