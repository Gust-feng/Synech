/**
 * A small server-read state contract for Panel hooks.
 *
 * `refreshing` and `error` may retain the last successful value. Consumers can
 * therefore keep rendering an authoritative snapshot while a later request
 * is in flight or has failed.
 */
export type AsyncRequestState<T, E = unknown> =
  | { readonly status: "idle"; readonly data?: T; readonly error?: undefined }
  | { readonly status: "loading"; readonly data?: undefined; readonly error?: undefined }
  | { readonly status: "refreshing"; readonly data: T; readonly error?: undefined }
  | { readonly status: "ready"; readonly data: T; readonly error?: undefined }
  | { readonly status: "error"; readonly data?: T; readonly error: E };

export function createIdleAsyncRequestState<T, E = never>(): AsyncRequestState<T, E> {
  return { status: "idle" };
}

/** Start a request, retaining a successful snapshot when one exists. */
export function startAsyncRequest<T, E>(state: AsyncRequestState<T, E>): AsyncRequestState<T, E> {
  if (state.data !== undefined) {
    return { status: "refreshing", data: state.data };
  }
  return { status: "loading" };
}

export function resolveAsyncRequest<T, E = never>(data: T): AsyncRequestState<T, E> {
  return { status: "ready", data };
}

/** Record a failed request while preserving the previous snapshot if present. */
export function failAsyncRequest<T, E>(state: AsyncRequestState<T, E>, error: E): AsyncRequestState<T, E> {
  return state.data === undefined
    ? { status: "error", error }
    : { status: "error", data: state.data, error };
}

/** Stop an in-flight request when its owner is disabled or unmounted. */
export function settleAsyncRequest<T, E>(state: AsyncRequestState<T, E>): AsyncRequestState<T, E> {
  switch (state.status) {
    case "refreshing":
      return { status: "ready", data: state.data };
    case "loading":
      return { status: "idle" };
    default:
      return state;
  }
}
