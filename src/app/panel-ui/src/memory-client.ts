import { requestJson } from "./api";
import type {
  MemoryNote,
  MemoryOwner,
  MemoryOwnerSelection,
  MemorySnapshot,
  PathDependencyDeleteInput,
  PathDependency,
} from "./contracts/memory";

type MemorySnapshotResponse = Omit<MemorySnapshot, "owner"> & {
  readonly ok?: boolean;
  /** The HTTP adapter serializes absent owner context as null. */
  readonly owner?: MemoryOwner | null;
};

type MemorySnapshotRequest = {
  readonly conversationId?: string;
  readonly owner?: MemoryOwnerSelection;
  readonly signal?: AbortSignal;
};

export async function fetchMemorySnapshot(
  request: MemorySnapshotRequest = {},
): Promise<MemorySnapshot> {
  const query = queryString(request);
  const response = await requestJson<MemorySnapshotResponse>(`/api/memory${query}`, { signal: request.signal });
  return {
    conversationId: response.conversationId ?? request.conversationId,
    owner: response.owner ?? request.owner,
    owners: response.owners ?? [],
    globalNote: response.globalNote,
    ownerNote: response.ownerNote,
    pathDependencies: response.pathDependencies ?? [],
    history: response.history ?? [],
  };
}

export async function fetchPathDependency(
  memoryId: string,
  request: Omit<MemorySnapshotRequest, "signal"> & { readonly signal?: AbortSignal } = {},
): Promise<PathDependency> {
  const query = queryString(request);
  const response = await requestJson<{ readonly dependency: PathDependency }>(
    `/api/memory/path-dependencies/${encodeURIComponent(memoryId)}${query}`,
    { signal: request.signal },
  );
  return response.dependency;
}

export async function deleteMemoryNote(
  scope: "global" | "owner",
  input: { readonly ownerKind?: "space" | "workspace"; readonly ownerId?: string; readonly expectedVersion: string },
): Promise<MemoryNote> {
  const response = await requestJson<{ readonly notebook: MemoryNote }>(
    `/api/memory/notes/${scope}`,
    {
      method: "DELETE",
      body: JSON.stringify(input),
    },
  );
  return response.notebook;
}

export async function deletePathDependency(
  memoryId: string,
  input: PathDependencyDeleteInput,
): Promise<void> {
  await requestJson<unknown>(
    `/api/memory/path-dependencies/${encodeURIComponent(memoryId)}`,
    {
      method: "DELETE",
      body: JSON.stringify(input),
    },
  );
}

function queryString(request: Pick<MemorySnapshotRequest, "conversationId" | "owner">): string {
  const params = new URLSearchParams();
  if (request.conversationId !== undefined) params.set("conversationId", request.conversationId);
  if (request.owner !== undefined && request.owner.kind !== "global") {
    params.set("ownerKind", request.owner.kind);
    params.set("ownerId", request.owner.id);
  }
  const value = params.toString();
  return value.length === 0 ? "" : `?${value}`;
}
