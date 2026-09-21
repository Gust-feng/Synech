import type { ConfigCenter } from "../../config-center/index.js";
import type { ResearchFeature } from "../../research/index.js";
import type { ResearchApplication } from "../../application/research-application.js";
import { createResearchApplication } from "../../application/research-application.js";
import { createConfigCenterResearchModel } from "../research/research-model.js";
import { createConfigCenterResearchSearch } from "../research/research-search.js";
import { createResearchContentFetcher } from "../research/research-content.js";
import { createResearchWorker, type ResearchWorker } from "../research/research-worker.js";

/**
 * 深度研究能力组合：显式创建端口、应用与执行 worker，并交出唯一入口。
 *
 * 与其他 composition builder 相同的纪律：只做装配与依赖注入，不做业务判断。
 * Search provider 与模型都经 ConfigCenter 解析——研究不持有第二份配置。
 */
export type ResearchRuntime = {
  readonly application: ResearchApplication;
  readonly worker: ResearchWorker;
};

export function createResearchRuntime(input: {
  readonly feature: Pick<ResearchFeature, "commands" | "queries" | "events" | "cancel" | "ready">;
  readonly configCenter: ConfigCenter;
  /** 可注入的抓取实现（测试或宿主替换浏览器能力）。 */
  readonly contentFetcher?: ReturnType<typeof createResearchContentFetcher>;
  readonly onDiagnostic?: (topic: string, error: unknown) => void;
}): ResearchRuntime {
  const search = createConfigCenterResearchSearch({ configCenter: input.configCenter });
  const content = input.contentFetcher ?? createResearchContentFetcher({});
  const application = createResearchApplication({
    feature: input.feature,
    model: createConfigCenterResearchModel({ configCenter: input.configCenter }),
    search: search.port,
    content,
    readiness: async () => ({ search: await search.readiness() }),
    ...(input.onDiagnostic === undefined ? {} : { onDiagnostic: input.onDiagnostic }),
  });
  const worker = createResearchWorker({
    feature: input.feature,
    application,
    ...(input.onDiagnostic === undefined ? {} : { onDiagnostic: input.onDiagnostic }),
  });
  return { application, worker };
}
