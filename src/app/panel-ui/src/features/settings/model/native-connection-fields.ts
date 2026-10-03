import type { ModelProviderPreset } from "@panel-api/config";

type Connection = NonNullable<ModelProviderPreset["connection"]>;
export type NativeConnectionField = {
  readonly key: Exclude<keyof Connection, "authMode">;
  readonly label: string;
};

export function nativeConnectionFields(
  providerId: string | undefined,
  authMode: Connection["authMode"],
): readonly NativeConnectionField[] {
  switch (providerId) {
    case "google-vertex":
      return [
        { key: "cloudProject", label: "Google Cloud 项目" },
        { key: "cloudLocation", label: "区域" },
        ...(authMode === "ambient" ? [{ key: "credentialsPath" as const, label: "服务账号凭据文件" }] : []),
      ];
    case "amazon-bedrock":
      return [
        { key: "awsRegion", label: "AWS 区域" },
        ...(authMode === "ambient" ? [{ key: "awsProfile" as const, label: "AWS 配置名称" }] : []),
      ];
    case "azure-openai-responses":
      return [
        { key: "azureResource", label: "Azure 资源名称" },
        { key: "azureDeployment", label: "部署名称" },
        { key: "azureApiVersion", label: "API 版本" },
      ];
    case "cloudflare-ai-gateway":
      return [
        { key: "cloudflareAccountId", label: "Cloudflare 账号 ID" },
        { key: "cloudflareGatewayId", label: "网关 ID" },
      ];
    case "cloudflare-workers-ai":
      return [{ key: "cloudflareAccountId", label: "Cloudflare 账号 ID" }];
    default:
      return [];
  }
}

export function hasNativeServiceAddress(providerId: string | undefined): boolean {
  return providerId !== "cloudflare-workers-ai" && providerId !== "cloudflare-ai-gateway";
}
