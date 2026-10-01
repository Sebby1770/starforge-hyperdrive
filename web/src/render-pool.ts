/**
 * Parallel frame rendering across a pool of engine instances.
 *
 * Every pixel the engine writes depends only on its own coordinate and a set of
 * per-frame constants, so a frame can be cut into horizontal bands and rendered
 * by several independent engine instances at once with bit-identical output.
 * Each worker owns its own WebAssembly instance (and therefore its own memory);
 * the main thread compiles the module once and hands the compiled module to
 * every worker, so the bytes are fetched and validated a single time.
 *
 * Frames are serialised: a render does not start until the previous one has
 * resolved. That keeps one reusable output buffer safe, and it means a caller
 * that consumes `pixels` synchronously inside its `then` never sees them change
 * underneath it. Callers that need the pixels later must copy them.
 */

export type EngineParams = {
  scale: number;
  mode: number;
  /** Engine-space intensity (the UI percentage divided by 100). */
  intensity: number;
  /** Engine-space hue in turns (the UI degrees divided by 360). */
  hue: number;
  seed: number;
  pointerX: number;
  pointerY: number;
  pointerDown: boolean;
  elapsedMs: number;
};

export type PoolFrame = {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  /** Mean per-pixel exposure, matching the engine's own `flux()`. */
  flux: number;
};

export type WorkerRequest =
  | { type: "init"; module: WebAssembly.Module }
  | { type: "render"; id: number; params: EngineParams; y0: number; y1: number };

export type WorkerReply =
  | { type: "ready" }
  | { type: "init-error"; error: string }
  | {
      type: "band";
      id: number;
      y0: number;
      y1: number;
      width: number;
      height: number;
      sum: number;
      bytes: ArrayBuffer;
    }
  | { type: "band-error"; id: number; error: string };

/** Minimal worker surface, so tests can drive the pool with fakes. */
export type PoolWorker = {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  onmessage: ((event: { data: WorkerReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

/** Ceiling on pool size; beyond this the per-band copy starts to dominate. */
export const MAX_POOL_WORKERS = 8;

/**
 * Split `[0, height)` into at most `bands` contiguous, non-overlapping, non-empty
 * row ranges that together cover every row exactly once.
 */
export function bandRanges(height: number, bands: number): Array<[number, number]> {
  const rows = Math.max(0, Math.floor(height));
  const count = Math.max(1, Math.min(Math.floor(bands) || 1, rows || 1));
  const ranges: Array<[number, number]> = [];

  for (let index = 0; index < count; index += 1) {
    const y0 = Math.floor((index * rows) / count);
    const y1 = Math.floor(((index + 1) * rows) / count);

    if (y1 > y0) {
      ranges.push([y0, y1]);
    }
  }

  return ranges;
}

/**
 * Workers to spawn for a machine with `cores` logical cores.
 *
 * One core is left for the UI thread. Returns 0 when a pool would not help —
 * with a single worker the frame is merely moved off-thread and pays a copy for
 * it — so the caller keeps rendering on the main thread instead.
 */
export function poolSizeFor(cores: number | undefined): number {
  const available = Number.isFinite(cores) && (cores as number) > 0 ? Math.floor(cores as number) : 1;
  const workers = Math.min(MAX_POOL_WORKERS, available - 1);
  return workers >= 2 ? workers : 0;
}

export class RenderPool {
  readonly size: number;

  private readonly workers: PoolWorker[];
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private buffer = new Uint8ClampedArray(0);
  private disposed = false;
  private readonly handlers = new Map<number, (reply: WorkerReply) => void>();

  private constructor(workers: PoolWorker[]) {
    this.workers = workers;
    this.size = workers.length;

    for (const worker of workers) {
      worker.onmessage = (event) => {
        const reply = event.data;

        if (reply.type === "band" || reply.type === "band-error") {
          this.handlers.get(reply.id)?.(reply);
        }
      };
    }
  }

  /**
   * Start `size` workers and wait for every one to instantiate the engine.
   *
   * Resolves to null — never rejects — when the pool cannot be built, so the
   * caller simply keeps its single-threaded path.
   */
  static async create(
    module: WebAssembly.Module,
    size: number,
    spawn: () => PoolWorker,
    timeoutMs = 10_000
  ): Promise<RenderPool | null> {
    if (size < 2) {
      return null;
    }

    const workers: PoolWorker[] = [];

    try {
      for (let index = 0; index < size; index += 1) {
        workers.push(spawn());
      }

      await Promise.all(workers.map((worker) => handshake(worker, module, timeoutMs)));
      return new RenderPool(workers);
    } catch {
      for (const worker of workers) {
        worker.terminate();
      }

      return null;
    }
  }

  /** Render one frame. Frames run strictly one after another. */
  render(params: EngineParams): Promise<PoolFrame> {
    const run = () => this.renderNow(params);
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  dispose() {
    this.disposed = true;

    for (const worker of this.workers) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }

    for (const handler of this.handlers.values()) {
      handler({ type: "band-error", id: -1, error: "Render pool disposed." });
    }

    this.handlers.clear();
  }

  private renderNow(params: EngineParams): Promise<PoolFrame> {
    if (this.disposed) {
      return Promise.reject(new Error("Render pool disposed."));
    }

    return new Promise<PoolFrame>((resolve, reject) => {
      const id = this.nextId;
      this.nextId += 1;

      // The engine clamps the scale itself; band against the height it will
      // actually use, which every reply then confirms.
      const scale = Math.min(8, Math.max(2, Math.round(params.scale)));
      const expectedHeight = 98 * scale;
      const bands = bandRanges(expectedHeight, this.workers.length);
      let remaining = bands.length;
      let fluxSum = 0;
      let frameWidth = 0;

      const settle = (error?: Error) => {
        this.handlers.delete(id);
        for (const worker of this.workers) {
          worker.onerror = null;
        }

        if (error) {
          reject(error);
        }
      };

      this.handlers.set(id, (reply) => {
        if (reply.type === "band-error") {
          settle(new Error(reply.error));
          return;
        }

        if (reply.type !== "band") {
          return;
        }

        if (reply.height !== expectedHeight || (frameWidth && reply.width !== frameWidth)) {
          settle(new Error("Render workers disagreed on the frame size."));
          return;
        }

        frameWidth = reply.width;
        const length = reply.width * reply.height * 4;

        if (this.buffer.length !== length) {
          this.buffer = new Uint8ClampedArray(length);
        }

        this.buffer.set(new Uint8Array(reply.bytes), reply.y0 * reply.width * 4);
        fluxSum += reply.sum;
        remaining -= 1;

        if (remaining === 0) {
          settle();
          resolve({
            pixels: this.buffer,
            width: frameWidth,
            height: expectedHeight,
            flux: fluxSum / (frameWidth * expectedHeight)
          });
        }
      });

      for (const worker of this.workers) {
        worker.onerror = () => settle(new Error("A render worker crashed."));
      }

      bands.forEach(([y0, y1], index) => {
        this.workers[index].postMessage({ type: "render", id, params: { ...params, scale }, y0, y1 });
      });
    });
  }
}

function handshake(worker: PoolWorker, module: WebAssembly.Module, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Render worker did not start.")), timeoutMs);

    worker.onmessage = (event) => {
      if (event.data.type === "ready") {
        clearTimeout(timer);
        resolve();
      } else if (event.data.type === "init-error") {
        clearTimeout(timer);
        reject(new Error(event.data.error));
      }
    };
    worker.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Render worker failed to load."));
    };

    worker.postMessage({ type: "init", module });
  });
}
