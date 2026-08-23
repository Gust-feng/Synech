export type SseResponseWriterOptions = {
  readonly maxQueuedFrames?: number;
  readonly onFailure?: (error: unknown) => void;
};

export type SseWritableResponse = {
  readonly writableEnded: boolean;
  write(frame: string): boolean;
  once(event: "drain" | "close" | "error", listener: () => void): unknown;
  off(event: "drain" | "close" | "error", listener: () => void): unknown;
};

/** A small transport guard: serialize complete frames and honor Node's drain signal. */
export class SseResponseWriter {
  private readonly maxQueuedFrames: number;
  private readonly onFailure: (error: unknown) => void;
  private tail: Promise<void> = Promise.resolve();
  private queuedFrames = 0;
  private closed = false;
  private releaseDrain: ((drained: boolean) => void) | undefined;

  constructor(
    private readonly response: SseWritableResponse,
    options: SseResponseWriterOptions = {},
  ) {
    const maxQueuedFrames = options.maxQueuedFrames ?? 256;
    if (!Number.isSafeInteger(maxQueuedFrames) || maxQueuedFrames <= 0) {
      throw new Error("SSE maxQueuedFrames must be a positive safe integer.");
    }
    this.maxQueuedFrames = maxQueuedFrames;
    this.onFailure = options.onFailure ?? (() => undefined);
  }

  async write(frame: string): Promise<boolean> {
    if (this.closed || this.response.writableEnded) return false;
    if (this.response.write(frame)) return true;
    return this.waitForDrain();
  }

  enqueue(frame: string): boolean {
    return this.enqueueTask(async () => {
      await this.write(frame);
    });
  }

  enqueueTask(task: () => Promise<void>): boolean {
    if (this.closed || this.response.writableEnded || this.queuedFrames >= this.maxQueuedFrames) {
      return false;
    }
    this.queuedFrames += 1;
    this.tail = this.tail
      .then(async () => {
        await task();
      })
      .catch((error: unknown) => {
        this.onFailure(error);
      })
      .finally(() => {
        this.queuedFrames -= 1;
      });
    return true;
  }

  async idle(): Promise<void> {
    await this.tail;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseDrain?.(false);
    this.releaseDrain = undefined;
  }

  private waitForDrain(): Promise<boolean> {
    if (this.closed || this.response.writableEnded) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (drained: boolean) => {
        if (settled) return;
        settled = true;
        this.response.off("drain", onDrain);
        this.response.off("close", onClosed);
        this.response.off("error", onClosed);
        if (this.releaseDrain === finish) this.releaseDrain = undefined;
        resolve(drained);
      };
      const onDrain = () => finish(true);
      const onClosed = () => finish(false);
      this.releaseDrain = finish;
      this.response.once("drain", onDrain);
      this.response.once("close", onClosed);
      this.response.once("error", onClosed);
      if (this.closed || this.response.writableEnded) finish(false);
    });
  }
}
