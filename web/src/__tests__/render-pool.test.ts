import { describe, expect, it } from "vitest";
import {
  MAX_POOL_WORKERS,
  RenderPool,
  bandRanges,
  poolSizeFor,
  type EngineParams,
  type PoolWorker,
  type WorkerReply,
  type WorkerRequest
} from "../render-pool";

const PARAMS: EngineParams = {
  scale: 2,
  mode: 0,
  intensity: 0.76,
  hue: 0,
  seed: 1770,
  pointerX: 0,
  pointerY: 0,
  pointerDown: false,
  elapsedMs: 1000
};

/**
 * Stand-in for a render worker.
 *
 * Every pixel byte encodes its own row (`y % 251`), so an assembled frame proves
 * that each band landed at the right offset. Each row contributes exactly 1.0 of
 * exposure per pixel, making the expected flux trivially 1. Replies arrive after
 * a per-worker delay, deliberately out of band order.
 */
class FakeWorker implements PoolWorker {
  onmessage: ((event: { data: WorkerReply }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;
  requests: WorkerRequest[] = [];

  constructor(
    private readonly delayMs: number,
    private readonly behaviour: "ok" | "init-error" | "silent" | "band-error" | "wrong-size" = "ok"
  ) {}

  postMessage(message: WorkerRequest) {
    this.requests.push(message);

    setTimeout(() => {
      if (this.terminated) return;

      if (message.type === "init") {
        if (this.behaviour === "silent") return;
        this.reply(
          this.behaviour === "init-error"
            ? { type: "init-error", error: "no engine" }
            : { type: "ready" }
        );
        return;
      }

      if (this.behaviour === "band-error") {
        this.reply({ type: "band-error", id: message.id, error: "engine trapped" });
        return;
      }

      const scale = message.params.scale;
      const width = 160 * scale;
      const height = this.behaviour === "wrong-size" ? 98 * scale + 2 : 98 * scale;
      const bytes = new Uint8Array((message.y1 - message.y0) * width * 4);
      for (let y = message.y0; y < message.y1; y += 1) {
        bytes.fill(y % 251, (y - message.y0) * width * 4, (y - message.y0 + 1) * width * 4);
      }
      this.reply({
        type: "band",
        id: message.id,
        y0: message.y0,
        y1: message.y1,
        width,
        height,
        sum: (message.y1 - message.y0) * width,
        bytes: bytes.buffer
      });
    }, this.delayMs);
  }

  terminate() {
    this.terminated = true;
  }

  private reply(data: WorkerReply) {
    this.onmessage?.({ data });
  }
}

const fakeModule = {} as WebAssembly.Module;

async function poolOf(delays: number[], behaviour?: ConstructorParameters<typeof FakeWorker>[1]) {
  const workers = delays.map((delay) => new FakeWorker(delay, behaviour));
  let next = 0;
  const pool = await RenderPool.create(fakeModule, workers.length, () => workers[next++], 200);
  return { pool, workers };
}

describe("bandRanges", () => {
  it("covers every row exactly once, contiguously, with no empty bands", () => {
    for (const height of [1, 2, 7, 98, 196, 294, 392, 588, 784]) {
      for (const bands of [1, 2, 3, 5, 7, 8, 11]) {
        const ranges = bandRanges(height, bands);
        expect(ranges[0][0]).toBe(0);
        expect(ranges[ranges.length - 1][1]).toBe(height);
        ranges.forEach(([y0, y1], index) => {
          expect(y1).toBeGreaterThan(y0);
          if (index > 0) expect(y0).toBe(ranges[index - 1][1]);
        });
        expect(ranges.length).toBeLessThanOrEqual(Math.min(bands, height));
      }
    }
  });

  it("keeps band sizes within one row of each other", () => {
    const sizes = bandRanges(196, 8).map(([y0, y1]) => y1 - y0);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it("never asks for more bands than there are rows", () => {
    expect(bandRanges(3, 8)).toEqual([[0, 1], [1, 2], [2, 3]]);
  });

  it("degrades to a single band for nonsense input", () => {
    expect(bandRanges(10, 0)).toEqual([[0, 10]]);
    expect(bandRanges(10, Number.NaN)).toEqual([[0, 10]]);
    expect(bandRanges(0, 4)).toEqual([]);
  });
});

describe("poolSizeFor", () => {
  it("leaves a core for the UI thread and caps the pool", () => {
    expect(poolSizeFor(4)).toBe(3);
    expect(poolSizeFor(9)).toBe(8);
    expect(poolSizeFor(64)).toBe(MAX_POOL_WORKERS);
  });

  it("declines a pool that could not beat the main thread", () => {
    // One worker only moves the frame off-thread and pays a copy for it.
    expect(poolSizeFor(1)).toBe(0);
    expect(poolSizeFor(2)).toBe(0);
    expect(poolSizeFor(undefined)).toBe(0);
    expect(poolSizeFor(Number.NaN)).toBe(0);
  });
});

describe("RenderPool", () => {
  it("assembles out-of-order bands into the right rows", async () => {
    // Later bands answer first.
    const { pool } = await poolOf([40, 30, 20, 10]);
    expect(pool).not.toBeNull();

    const frame = await pool!.render(PARAMS);
    expect(frame.width).toBe(320);
    expect(frame.height).toBe(196);
    expect(frame.pixels.length).toBe(320 * 196 * 4);

    for (let y = 0; y < frame.height; y += 1) {
      const rowStart = y * frame.width * 4;
      expect(frame.pixels[rowStart]).toBe(y % 251);
      expect(frame.pixels[rowStart + frame.width * 4 - 1]).toBe(y % 251);
    }
  });

  it("recovers the frame mean from per-band sums", async () => {
    const { pool } = await poolOf([5, 1, 3]);
    const frame = await pool!.render(PARAMS);
    expect(frame.flux).toBeCloseTo(1, 10);
  });

  it("sends every worker the complete engine state and one distinct band", async () => {
    const { pool, workers } = await poolOf([1, 1, 1, 1]);
    await pool!.render({ ...PARAMS, mode: 7, seed: 42, hue: 0.25, pointerDown: true });

    const renders = workers.map((worker) => worker.requests.find((r) => r.type === "render"));
    renders.forEach((request) => {
      expect(request?.type).toBe("render");
      if (request?.type !== "render") return;
      expect(request.params).toMatchObject({ mode: 7, seed: 42, hue: 0.25, pointerDown: true });
    });

    const bands = renders.map((r) => (r?.type === "render" ? [r.y0, r.y1] : null));
    expect(new Set(bands.map((b) => JSON.stringify(b))).size).toBe(workers.length);
  });

  it("serialises frames so a second render cannot overwrite the first's pixels mid-use", async () => {
    const { pool } = await poolOf([10, 10]);
    const order: string[] = [];

    const first = pool!.render({ ...PARAMS, scale: 2 }).then((frame) => {
      order.push(`first:${frame.height}`);
      // Consumed synchronously, as the contract requires.
      return frame.pixels[0];
    });
    const second = pool!.render({ ...PARAMS, scale: 3 }).then((frame) => {
      order.push(`second:${frame.height}`);
    });

    await Promise.all([first, second]);
    expect(order).toEqual(["first:196", "second:294"]);
  });

  it("clamps the scale the same way the engine does", async () => {
    const { pool } = await poolOf([1, 1]);
    expect((await pool!.render({ ...PARAMS, scale: 99 })).height).toBe(98 * 8);
    expect((await pool!.render({ ...PARAMS, scale: 0 })).height).toBe(98 * 2);
  });

  it("rejects the frame when any worker reports a render error", async () => {
    // Both workers start cleanly; the second then fails every render.
    const workers = [new FakeWorker(1), new FakeWorker(1, "band-error")];
    let next = 0;
    const pool = await RenderPool.create(fakeModule, 2, () => workers[next++], 200);
    expect(pool).not.toBeNull();

    await expect(pool!.render(PARAMS)).rejects.toThrow("engine trapped");
  });

  it("keeps serving frames after a rejected one", async () => {
    const { pool } = await poolOf([1, 1], "wrong-size");
    await expect(pool!.render(PARAMS)).rejects.toThrow();
    // A failed frame must not wedge the serial chain.
    await expect(pool!.render(PARAMS)).rejects.toThrow("disagreed");
  });

  it("rejects a frame whose workers disagree on its size", async () => {
    const { pool } = await poolOf([1, 1], "wrong-size");
    await expect(pool!.render(PARAMS)).rejects.toThrow("disagreed");
  });

  it("rejects pending and future frames once disposed", async () => {
    const { pool, workers } = await poolOf([50, 50]);
    const pending = pool!.render(PARAMS);
    pool!.dispose();

    await expect(pending).rejects.toThrow();
    await expect(pool!.render(PARAMS)).rejects.toThrow("disposed");
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  describe("create", () => {
    it("returns null rather than throwing when a worker cannot load the engine", async () => {
      const { pool, workers } = await poolOf([1, 1, 1], "init-error");
      expect(pool).toBeNull();
      expect(workers.every((worker) => worker.terminated)).toBe(true);
    });

    it("returns null when a worker never answers", async () => {
      const { pool, workers } = await poolOf([1, 1], "silent");
      expect(pool).toBeNull();
      expect(workers.every((worker) => worker.terminated)).toBe(true);
    });

    it("refuses to build a pool too small to help", async () => {
      expect(await RenderPool.create(fakeModule, 1, () => new FakeWorker(1))).toBeNull();
    });
  });
});
