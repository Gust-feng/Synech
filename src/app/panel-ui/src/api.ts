export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const message = errorMessage(parsed) ?? `请求失败：${response.status}`;
    throw new ApiError(response.status, errorCode(parsed), message);
  }
  return parsed as T;
}

export function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(path, init);
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deleteJson<T>(path: string): Promise<T> {
  return requestJson<T>(path, { method: "DELETE" });
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as { readonly error?: { readonly message?: unknown }; readonly message?: unknown };
  if (typeof record.error?.message === "string") {
    return record.error.message;
  }
  return typeof record.message === "string" ? record.message : undefined;
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as { readonly error?: { readonly code?: unknown }; readonly code?: unknown };
  if (typeof record.error?.code === "string") {
    return record.error.code;
  }
  return typeof record.code === "string" ? record.code : undefined;
}