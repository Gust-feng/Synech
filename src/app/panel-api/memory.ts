import type { MemoryOwner as DomainMemoryOwner } from "../../domain/memory/index.js";
import type { AgentNotebook } from "../agent-notes/index.js";
import type { OrdinaryMemoryFact } from "../ordinary-agent/index.js";
import type { PathDependency as DomainPathDependency } from "../path-dependencies/index.js";

export type MemoryOwner =
  | Extract<DomainMemoryOwner, { readonly kind: "global" }>
  | (Exclude<DomainMemoryOwner, { readonly kind: "global" }> & { readonly title?: string });

export type MemoryOwnerSelection = DomainMemoryOwner;
export type MemoryNote = AgentNotebook;
export type MemoryVerification = DomainPathDependency["verification"];
export type MemoryVerificationStatus = MemoryVerification["status"];
export type MemorySourceRef = string | DomainPathDependency["sourceRunRefs"][number];

export type MemoryReferenceFact = Pick<
  OrdinaryMemoryFact,
  "factId" | "kind" | "runId" | "conversationId" | "revision" | "title" | "recordedAt" | "note"
>;

export type PathDependency = Omit<DomainPathDependency, "owner"> & {
  readonly kind: "path_dependency";
  readonly owner: MemoryOwner;
  readonly excerpt: string;
  readonly sourceRunCount: number;
  readonly evidenceCount: number;
  readonly readCount: number;
  readonly useCount: number;
  readonly references: readonly MemoryReferenceFact[];
};

export type DeletedMemoryHistory = {
  readonly historyKey: string;
  readonly id: string;
  readonly kind: "path_dependency";
  readonly owner: MemoryOwner;
  readonly title: string;
  readonly revision: number;
  readonly available: false;
  readonly readCount: number;
  readonly useCount: number;
  readonly references: readonly MemoryReferenceFact[];
};

export type MemorySnapshot = {
  readonly conversationId?: string;
  readonly owner?: MemoryOwner;
  readonly owners: readonly MemoryOwner[];
  readonly globalNote: MemoryNote;
  readonly ownerNote?: MemoryNote;
  readonly pathDependencies: readonly PathDependency[];
  readonly history: readonly DeletedMemoryHistory[];
};

export type MemorySnapshotResponse = Omit<MemorySnapshot, "owner"> & {
  readonly ok: true;
  readonly owner: MemoryOwner | null;
  readonly scopes: readonly DomainMemoryOwner[];
  readonly notes: {
    readonly global: MemoryNote;
    readonly owner?: MemoryNote;
  };
};

export type PathDependencyDeleteInput = {
  readonly conversationId?: string;
  readonly ownerKind?: "space" | "workspace";
  readonly ownerId?: string;
  readonly expectedRevision: number;
};

export type PathDependencyResponse = {
  readonly ok: true;
  readonly dependency: PathDependency;
};

export type MemoryPathDependencyScope =
  | { readonly kind: "global" }
  | { readonly kind: "space"; readonly id: string }
  | { readonly kind: "workspace"; readonly id: string };

export async function fetchMemoryPathDependencies(scope: MemoryPathDependencyScope): Promise<{
  readonly owner: MemoryOwner | null;
  readonly pathDependencies: readonly PathDependency[];
}> {
  const query = new URLSearchParams();
  if (scope.kind !== "global") {
    query.set("ownerKind", scope.kind);
    query.set("ownerId", scope.id);
  }
  const suffix = query.size === 0 ? "" : `?${query}`;
  const response = await fetch(`/api/memory/path-dependencies${suffix}`, { method: "GET" });
  await assertMemoryResponse(response, "无法读取路径依赖");
  return await response.json() as {
    readonly owner: MemoryOwner | null;
    readonly pathDependencies: readonly PathDependency[];
  };
}

export async function deleteMemoryPathDependency(input: {
  readonly memoryId: string;
  readonly scope: MemoryPathDependencyScope;
  readonly expectedRevision: number;
}): Promise<void> {
  const body = input.scope.kind === "global"
    ? { expectedRevision: input.expectedRevision }
    : {
        ownerKind: input.scope.kind,
        ownerId: input.scope.id,
        expectedRevision: input.expectedRevision,
      };
  const response = await fetch(`/api/memory/path-dependencies/${encodeURIComponent(input.memoryId)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await assertMemoryResponse(response, "无法删除路径依赖");
}

export async function saveMemoryPathDependency(input: {
  readonly scope: MemoryPathDependencyScope;
  readonly title: string;
  readonly methodology: string;
  readonly tags: readonly string[];
  readonly memoryId?: string;
  readonly expectedRevision?: number;
}): Promise<PathDependency> {
  const body = {
    scope: input.scope.kind === "global" ? "global" : "owner",
    ...(input.scope.kind === "global" ? {} : {
      ownerKind: input.scope.kind,
      ownerId: input.scope.id,
    }),
    title: input.title,
    methodology: input.methodology,
    tags: input.tags,
    ...(input.memoryId === undefined ? {} : { memoryId: input.memoryId }),
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
  };
  const endpoint = input.memoryId === undefined
    ? "/api/memory/path-dependencies"
    : `/api/memory/path-dependencies/${encodeURIComponent(input.memoryId)}`;
  const response = await fetch(endpoint, {
    method: input.memoryId === undefined ? "POST" : "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await assertMemoryResponse(response, "无法保存路径依赖");
  const payload = await response.json() as { readonly result: { readonly dependency: PathDependency } };
  return payload.result.dependency;
}

async function assertMemoryResponse(response: Response, fallback: string): Promise<void> {
  if (response.ok) return;
  let message = fallback;
  try {
    const payload = await response.json() as { readonly error?: { readonly message?: unknown } };
    if (typeof payload.error?.message === "string" && payload.error.message.length > 0) message = payload.error.message;
  } catch {
    // Keep a stable panel-facing fallback when an upstream failure is not JSON.
  }
  throw new Error(`${message}（${response.status}）`);
}
