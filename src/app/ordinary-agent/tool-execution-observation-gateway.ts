import type {
  ToolDefinition,
  ToolExecutionGateway,
  ToolExecutionMetricsSink,
  ToolOperationType,
} from "../../domain/tools/index.js";

/** Records executor activity without owning tool ordering or admission. */
export class ToolExecutionObservationGateway implements ToolExecutionGateway {
  private readonly operationTypes = new Map<string, ToolOperationType>();
  private activeCount = 0;

  constructor(
    private readonly inner: ToolExecutionGateway,
    private readonly metrics?: ToolExecutionMetricsSink,
  ) {
    for (const definition of inner.list()) {
      this.operationTypes.set(definition.name, definition.metadata?.operationType ?? "read-only");
    }
  }

  list(): ToolDefinition[] {
    return this.inner.list();
  }

  has(name: string): boolean {
    return this.inner.has(name);
  }

  preflight: ToolExecutionGateway["preflight"] = (request, context, permission) =>
    this.inner.preflight(request, context, permission);

  async execute(
    request: Parameters<ToolExecutionGateway["execute"]>[0],
    context: Parameters<ToolExecutionGateway["execute"]>[1],
    permission: Parameters<ToolExecutionGateway["execute"]>[2],
  ) {
    const startedAt = Date.now();
    this.activeCount += 1;
    const observedActiveCount = this.activeCount;
    try {
      return await this.inner.execute(request, context, permission);
    } finally {
      this.activeCount -= 1;
      this.metrics?.record({
        kind: "scheduling",
        toolName: request.toolName,
        operationType: this.operationTypes.get(request.toolName) ?? "read-only",
        queueWaitMs: 0,
        executionMs: Math.max(0, Date.now() - startedAt),
        activeCount: observedActiveCount,
      });
    }
  }

  async deliverResult(
    result: Parameters<NonNullable<ToolExecutionGateway["deliverResult"]>>[0],
    permission: Parameters<NonNullable<ToolExecutionGateway["deliverResult"]>>[1],
    ownerId: Parameters<NonNullable<ToolExecutionGateway["deliverResult"]>>[2],
  ) {
    if (this.inner.deliverResult === undefined) {
      throw new Error("Tool execution gateway does not support complete result delivery.");
    }
    return this.inner.deliverResult(result, permission, ownerId);
  }
}
