import { z } from "zod";
import type { ManagedAsset } from "./contracts.js";

const managedAssetSchema: z.ZodType<ManagedAsset> = z.object({
  id: z.string().min(1),
  kind: z.enum(["markdown", "pdf", "web", "image", "video", "audio", "code"]),
  title: z.string(),
  origin: z.enum(["library", "space"]).optional(),
  meta: z.string().optional(),
  thumbnail: z.string().optional(),
  markdown: z.string().optional(),
  pdf: z.object({ pages: z.array(z.string()) }).strict().optional(),
  web: z.object({ url: z.string(), site: z.string(), body: z.string() }).strict().optional(),
  image: z.object({ src: z.string(), alt: z.string(), caption: z.string().optional() }).strict().optional(),
  video: z.object({ src: z.string(), poster: z.string().optional(), duration: z.string().optional() }).strict().optional(),
  audio: z.object({ src: z.string(), duration: z.string().optional(), transcript: z.string().optional() }).strict().optional(),
  code: z.object({ language: z.string(), filename: z.string(), source: z.string() }).strict().optional(),
}).strict();

export function parseManagedAsset(value: unknown): ManagedAsset {
  return managedAssetSchema.parse(value);
}
