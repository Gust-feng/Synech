export type RemoteSearchState<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly previous?: readonly T[] }
  | { readonly status: 'ready'; readonly results: readonly T[] }
  | { readonly status: 'error'; readonly message: string; readonly previous?: readonly T[] }

export function beginRemoteSearch<T>(state: RemoteSearchState<T>): RemoteSearchState<T> {
  return {
    status: 'loading',
    previous: state.status === 'ready' ? state.results : state.status === 'error' ? state.previous : undefined,
  }
}

export function completeRemoteSearch<T>(results: readonly T[]): RemoteSearchState<T> {
  return { status: 'ready', results }
}

export function failRemoteSearch<T>(state: RemoteSearchState<T>, message: string): RemoteSearchState<T> {
  return {
    status: 'error',
    message,
    previous: state.status === 'loading' ? state.previous : undefined,
  }
}