import type { MemoryOwner } from "../../../domain/memory/index.js";
import type { OrdinaryAgentFeature } from "../../ordinary-agent/index.js";
import {
  renderMemoryBackgroundBlock,
  type MemoryBackgroundPort,
} from "../../memory/index.js";

/**
 * 会话背景绑定与供给解析（正式设计 §9.1/§9.3）：
 *
 * Run Birth 调用一次：读取会话绑定；未初始化时读取当前 Space 记忆 head 并持久化
 * `none | {memoryRevision, generation}`（幂等，绝不暗中补绑）；然后返回：
 * - initialBlock：当前请求的背景块（绑定版本仍可供给时）；
 * - resolvePerFreeze：每次 provider 请求冻结前复核 policy/generation/revision
 *   有效性的闭包（撤销后返回 undefined，不自动换绑）。
 *
 * Memory 不可用（端口缺席）时返回 undefined，主链路照常运行（可缺席组合）。
 */
export type MemoryBackgroundResolution = {
  readonly initialBlock: string | undefined;
  readonly resolvePerFreeze?: () => Promise<string | undefined>;
};

export type MemoryBackgroundResolver = (input: {
  readonly owner: MemoryOwner;
  readonly conversationId: string;
}) => Promise<MemoryBackgroundResolution | undefined>;

export function createMemoryBackgroundResolver(input: {
  readonly backgroundPort: MemoryBackgroundPort;
  /** 惰性委托：ordinaryAgentFeature 在组合根后段装配。 */
  readonly ordinary: () => Pick<OrdinaryAgentFeature, "queries" | "commands">;
}): MemoryBackgroundResolver {
  return async ({ owner, conversationId }) => {
    const ordinary = input.ordinary();
    let binding = await ordinary.queries.getMemoryBackground(conversationId);
    if (binding === undefined) {
      const head = await input.backgroundPort.getActiveSpaceMemoryHead(owner);
      binding = await ordinary.commands.bindMemoryBackground({
        conversationId,
        background: head === undefined
          ? { kind: "none", boundAt: new Date().toISOString() }
          : {
              kind: "revision",
              revisionId: head.revisionId,
              revision: head.revision,
              generation: head.generation,
              boundAt: new Date().toISOString(),
            },
      });
    }
    if (binding.kind === "none") {
      return { initialBlock: undefined };
    }
    const resolveOnce = async (): Promise<string | undefined> => {
      const background = await input.backgroundPort.resolveSupplyableBackground({
        owner,
        revisionId: binding.kind === "revision" ? binding.revisionId : "",
        generation: binding.kind === "revision" ? binding.generation : 0,
      });
      return background === undefined ? undefined : renderMemoryBackgroundBlock(background);
    };
    return {
      initialBlock: await resolveOnce(),
      resolvePerFreeze: resolveOnce,
    };
  };
}
