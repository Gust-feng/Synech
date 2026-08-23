import { postJson } from "./api";

export async function selectTaskWorkspaceDirectory(): Promise<string | undefined> {
  const response = await postJson<{
    readonly status?: "completed" | "cancelled";
    readonly directory?: string;
  }>("/api/context/workspace/select-directory", {});
  return response.status === "cancelled" ? undefined : response.directory;
}
