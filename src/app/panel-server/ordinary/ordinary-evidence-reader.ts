import type { OrdinaryAgentFeature } from "../../ordinary-agent/contracts.js";
import type {
  EvidenceTurn,
  EvidenceWindow,
  OrdinaryEvidenceReader,
} from "../../memory/contracts.js";

type EvidenceRunQueries = Pick<OrdinaryAgentFeature["queries"], "listStableEvidenceRuns">;

/**
 * 把 Ordinary 侧的稳定 run 投影适配成 Memory Capture 需要的连续证据窗。
 *
 * 归属与纪律（《手册》9.3）：
 * - 适配在 panel-server 层，Memory Feature 不直接 import Ordinary 仓储；
 * - 只接受从 fromOrdinal 起「连续无洞」的稳定 run：一旦中间某 ordinal 缺失
 *   （该轮尚未稳定/被隐藏），立即停止，游标只推进到连续块末端，绝不跳过缺口
 *   把游标推到 through（禁止 newest-first 截断后跳游标）；
 * - 每个稳定 run 展开为 user turn +（有文本时）assistant turn，user 在前；
 * - 区间内没有任何连续稳定证据时 nextCursor=undefined，调用方不得推进游标。
 */
export function createOrdinaryEvidenceReader(queries: EvidenceRunQueries): OrdinaryEvidenceReader {
  return {
    async readTurnWindow({ conversationId, fromOrdinal, through }) {
      const runs = await queries.listStableEvidenceRuns(conversationId, {
        fromOrdinal,
        throughOrdinal: through.ordinal,
      });

      const turns: EvidenceTurn[] = [];
      let expectedOrdinal = fromOrdinal;
      let coveredThrough = -1;
      let lastSourceRevision = -1;

      // queries 已按 ordinal 升序返回；这里只累加连续块。
      for (const run of runs) {
        if (run.ordinal !== expectedOrdinal) break;
        if (!run.turnMemoryOverrideOff) {
          turns.push({
            turnId: run.userTurnId,
            ordinal: run.ordinal,
            role: "user",
            text: run.userMessage,
            runId: run.runId,
            occurredAt: run.occurredAt,
            sourceRevision: run.sourceRevision,
          });
        }
        if (!run.turnMemoryOverrideOff && run.assistantText.length > 0) {
          turns.push({
            turnId: run.assistantTurnId,
            ordinal: run.ordinal,
            role: "assistant",
            text: run.assistantText,
            runId: run.runId,
            occurredAt: run.occurredAt,
            sourceRevision: run.sourceRevision,
          });
        }
        coveredThrough = run.ordinal;
        lastSourceRevision = run.sourceRevision;
        expectedOrdinal += 1;
      }

      const nextCursor = coveredThrough >= 0
        ? {
            conversationId,
            coveredThroughOrdinal: coveredThrough,
            sourceFingerprint: `rev:${lastSourceRevision}`,
          }
        : undefined;

      return { turns, nextCursor } satisfies EvidenceWindow;
    },
  };
}
