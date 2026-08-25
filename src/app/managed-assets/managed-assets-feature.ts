import type {
  ManagedAsset,
  ManagedAssetEvent,
  ManagedAssetRepository,
  ManagedAssetsFeature,
} from "./contracts.js";

export function createManagedAssetsFeature(repository: ManagedAssetRepository): ManagedAssetsFeature {
  const listeners = new Set<(event: ManagedAssetEvent) => void>();
  let released = false;
  let tail = Promise.resolve();
  const assertActive = (): void => {
    if (released) throw new Error("Managed assets feature is released");
  };
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    assertActive();
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const publish = (event: ManagedAssetEvent): void => {
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* Observers cannot alter a committed asset update. */ }
    }
  };

  return {
    commands: {
      async replace(asset: ManagedAsset) {
        await run(async () => {
          await repository.upsertMany([asset]);
          publish({ type: "managed_asset.changed", assetId: asset.id, operation: "replaced" });
        });
      },
      async updateText(input) {
        return await run(async () => {
          const result = await repository.updateText(input);
          if (result.status === "updated") publish({ type: "managed_asset.changed", assetId: input.id, operation: "text_updated" });
          return result;
        });
      },
      async updateCaption(input) {
        return await run(async () => {
          const result = await repository.updateCaption(input);
          if (result.status === "updated") publish({ type: "managed_asset.changed", assetId: input.id, operation: "caption_updated" });
          return result;
        });
      },
      async removeMany(assetIds) {
        await run(async () => {
          const ids = [...new Set(assetIds.filter((assetId) => assetId.length > 0))];
          if (ids.length === 0) return;
          await repository.removeMany(ids);
          for (const assetId of ids) {
            publish({ type: "managed_asset.changed", assetId, operation: "removed" });
          }
        });
      },
    },
    queries: {
      async get(id) { assertActive(); await tail; return await repository.get(id); },
      async list() { assertActive(); await tail; return await repository.list(); },
    },
    events: {
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    },
    async release() {
      if (released) return;
      released = true;
      await tail;
      listeners.clear();
    },
  };
}
