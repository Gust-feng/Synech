import { z } from "zod";

const connectionString = z.string().trim().min(1).optional();

export const modelProviderConnectionSettingsSchema = z.object({
  authMode: z.enum(["api_key", "oauth", "ambient"]),
  cloudProject: connectionString,
  cloudLocation: connectionString,
  credentialsPath: connectionString,
  awsRegion: connectionString,
  awsProfile: connectionString,
  azureResource: connectionString,
  azureApiVersion: connectionString,
  azureDeployment: connectionString,
  cloudflareAccountId: connectionString,
  cloudflareGatewayId: connectionString,
}).strict();
