import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { PanelHttpError, readJsonBody, writeJson } from "../http-utils.js";
import { ModelProviderAuthError, type ModelProviderAuthApplication } from "../../model-service-auth/model-provider-auth-application.js";

const sessionInput = z.object({ sessionId: z.string().min(1) }).strict();
const promptInput = sessionInput.extend({
  promptId: z.string().min(1),
  value: z.string().max(32_768),
});

export async function handlePanelModelAuthRoute(
  service: ModelProviderAuthApplication,
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  const match = /^\/api\/config\/model-profiles\/([^/]+)\/auth\/(login|status|respond|cancel|logout)$/.exec(url.pathname);
  if (match === null) return false;
  const action = match[2];
  const expectedMethod = action === "status" ? "GET" : "POST";
  if (request.method !== expectedMethod) return false;
  const profileId = decodeURIComponent(match[1] ?? "");
  try {
    const payload = action === "status" ? await service.status(profileId)
      : action === "login" ? await service.login(profileId)
      : action === "logout" ? await service.logout(profileId)
      : action === "respond"
        ? await service.respond(profileId, parseAuthBody(promptInput, await readJsonBody(request)))
        : await service.cancel(profileId, parseAuthBody(sessionInput, await readJsonBody(request)).sessionId);
    writeJson(response, 200, payload);
    return true;
  } catch (error) {
    if (error instanceof ModelProviderAuthError) {
      throw new PanelHttpError(error.code === "model_profile_not_found" ? 404 : 409, error.code, error.message);
    }
    throw error;
  }
}

function parseAuthBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new PanelHttpError(400, "invalid_model_auth_request", "模型登录请求无效。");
  return parsed.data;
}
