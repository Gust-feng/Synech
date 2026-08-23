export type PanelServerShutdown = {
  /** Result visible to close callers; may reject before cleanup has settled. */
  readonly completion: Promise<void>;
  /** Settles only after all runtime cleanup work has actually finished. */
  readonly cleanupSettled: Promise<void>;
};

/** Keeps Product Home ownership attached to runtime cleanup, including after a caller-visible timeout. */
export function createLeaseBoundClose(
  beginShutdown: () => PanelServerShutdown,
  releaseLease: () => Promise<void>,
): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => closing ??= (() => {
    const shutdown = beginShutdown();
    const leaseRelease = shutdown.cleanupSettled.then(releaseLease, releaseLease);
    // A timeout deliberately returns before cleanup; own any later release error.
    void leaseRelease.catch(() => undefined);
    return shutdown.completion.then(async () => {
      await leaseRelease;
    });
  })();
}
