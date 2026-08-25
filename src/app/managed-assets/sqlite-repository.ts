import type { SqliteRuntimeDatabase } from "../../adapters/runtime-storage/index.js";
import type { ManagedAssetRepository } from "./contracts.js";
import { parseManagedAsset } from "./managed-asset-validation.js";
import {
  MAX_MANAGED_ASSET_CAPTION_BYTES,
  replaceManagedAssetCaption,
  managedAssetCaptionFingerprint,
} from "./asset-caption.js";
import {
  editableManagedAssetText,
  MAX_MANAGED_ASSET_TEXT_BYTES,
  replaceManagedAssetText,
  managedAssetTextFingerprint,
} from "./asset-text.js";

const MIGRATIONS = [{
  version: 1,
  sql: `
    CREATE TABLE managed_assets (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    ) STRICT;
  `,
}] as const;

export function createSqliteManagedAssetRepository(database: SqliteRuntimeDatabase): ManagedAssetRepository {
  database.migrate("managed-assets", MIGRATIONS);
  const selectById = database.connection.prepare(
    "SELECT payload_json AS payloadJson FROM managed_assets WHERE id = ?",
  );
  const upsert = database.connection.prepare(`
    INSERT INTO managed_assets(id, payload_json) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json
  `);
  const remove = database.connection.prepare("DELETE FROM managed_assets WHERE id = ?");
  return {
    async get(id) {
      const row = selectById.get(id) as { payloadJson: string } | undefined;
      return row === undefined ? undefined : parseManagedAsset(JSON.parse(row.payloadJson));
    },
    async list() {
      return database.connection.prepare("SELECT payload_json AS payloadJson FROM managed_assets ORDER BY rowid").all()
        .map((row) => parseManagedAsset(JSON.parse(String((row as { payloadJson: string }).payloadJson))));
    },
    async upsertMany(assets) {
      database.transaction(() => {
        for (const asset of assets) {
          const value = parseManagedAsset(asset);
          upsert.run(value.id, JSON.stringify(value));
        }
      });
    },
    async removeMany(assetIds) {
      database.transaction(() => {
        for (const assetId of new Set(assetIds)) remove.run(assetId);
      });
    },
    async updateText(input) {
      if (Buffer.byteLength(input.text, "utf8") > MAX_MANAGED_ASSET_TEXT_BYTES) {
        return { status: "too_large" };
      }
      return database.transaction(() => {
        const row = selectById.get(input.id) as { payloadJson: string } | undefined;
        if (row === undefined) return { status: "not_found" } as const;
        const asset = parseManagedAsset(JSON.parse(row.payloadJson));
        const editable = editableManagedAssetText(asset);
        if (editable === undefined) return { status: "not_editable", kind: asset.kind } as const;
        const currentFingerprint = managedAssetTextFingerprint(editable.text);
        if (currentFingerprint !== input.expectedFingerprint) {
          return { status: "conflict", fingerprint: currentFingerprint } as const;
        }
        const updated = replaceManagedAssetText(asset, input.text);
        upsert.run(updated.id, JSON.stringify(updated));
        return {
          status: "updated",
          asset: updated,
          fingerprint: managedAssetTextFingerprint(input.text),
        } as const;
      });
    },
    async updateCaption(input) {
      if (Buffer.byteLength(input.caption, "utf8") > MAX_MANAGED_ASSET_CAPTION_BYTES) {
        return { status: "too_large" };
      }
      return database.transaction(() => {
        const row = selectById.get(input.id) as { payloadJson: string } | undefined;
        if (row === undefined) return { status: "not_found" } as const;
        const asset = parseManagedAsset(JSON.parse(row.payloadJson));
        if (asset.kind !== "image" || asset.image === undefined) return { status: "not_editable", kind: asset.kind } as const;
        const currentFingerprint = managedAssetCaptionFingerprint(asset.image.caption);
        if (currentFingerprint !== input.expectedFingerprint) {
          return { status: "conflict", fingerprint: currentFingerprint } as const;
        }
        const updated = replaceManagedAssetCaption(asset, input.caption);
        upsert.run(updated.id, JSON.stringify(updated));
        return {
          status: "updated",
          asset: updated,
          fingerprint: managedAssetCaptionFingerprint(updated.image?.caption),
        } as const;
      });
    },
  };
}
