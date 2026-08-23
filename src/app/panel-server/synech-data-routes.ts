import type { IncomingMessage, ServerResponse } from "node:http";

import { PanelHttpError, writeJson } from "./http-utils.js";
import { SynechDataMaintenanceError } from "./synech-data-maintenance.js";

export type SynechDataRouteDependencies = {
  readonly synechDataMaintenance: {
    health(): { readonly ok: boolean; readonly [key: string]: unknown };
    createBackup(): Promise<unknown>;
    selectAndStageRestore(): Promise<unknown>;
  };
};

export async function handlePanelSynechDataRoute(
  dependencies: SynechDataRouteDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (url.pathname === "/api/data/health" && request.method === "GET") {
    const health = dependencies.synechDataMaintenance.health();
    writeJson(response, health.ok ? 200 : 503, { ok: health.ok, health });
    return true;
  }
  if (url.pathname === "/api/data/backups" && request.method === "POST") {
    writeJson(response, 201, { ok: true, backup: await dependencies.synechDataMaintenance.createBackup() });
    return true;
  }
  if (url.pathname === "/api/data/restore/select" && request.method === "POST") {
    writeJson(response, 200, { ok: true, result: await dependencies.synechDataMaintenance.selectAndStageRestore() });
    return true;
  }
  return false;
}

export function synechDataHttpError(error: SynechDataMaintenanceError): PanelHttpError {
  switch (error.code) {
    case "restore_picker_unavailable":
      return new PanelHttpError(501, error.code, error.message);
    case "restore_source_invalid":
      return new PanelHttpError(400, error.code, error.message);
    case "data_maintenance_failed":
      return new PanelHttpError(500, error.code, error.message);
  }
}
