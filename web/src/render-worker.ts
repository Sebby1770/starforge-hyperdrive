/**
 * One band renderer in the parallel pool.
 *
 * Owns a private engine instance. For each request it applies the full engine
 * state (so no worker can drift from the main thread's instrument), renders its
 * rows with `render_band`, and transfers exactly those rows back. See
 * `render-pool.ts` for why banding is exact.
 */

import type { WorkerReply, WorkerRequest } from "./render-pool";

type BandEngine = {
  memory: WebAssembly.Memory;
  width: () => number;
  height: () => number;
  framebuffer_ptr: () => number;
  set_resolution: (scale: number) => number;
  set_mode: (mode: number) => void;
  set_intensity: (value: number) => void;
  set_hue: (value: number) => void;
  reseed: (value: number) => void;
  set_pointer: (x: number, y: number, down: number) => void;
  render_band: (elapsedMs: number, y0: number, y1: number) => number;
};

// The project compiles against the DOM lib, whose `self.postMessage` is the
// window form (it takes a target origin). Narrow to the worker shape instead of
// mixing lib files, which conflict.
const scope = self as unknown as {
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

let engine: BandEngine | null = null;

scope.onmessage = async (event) => {
  const request = event.data;

  if (request.type === "init") {
    try {
      const instance = await WebAssembly.instantiate(request.module, {});
      const exports = instance.exports as unknown as BandEngine;

      if (typeof exports.render_band !== "function") {
        throw new Error("This engine build has no render_band export.");
      }

      engine = exports;
      scope.postMessage({ type: "ready" });
    } catch (error) {
      scope.postMessage({ type: "init-error", error: describe(error) });
    }

    return;
  }

  if (request.type !== "render") {
    return;
  }

  try {
    if (!engine) {
      throw new Error("Render worker used before it was initialised.");
    }

    const { params, y0, y1, id } = request;
    engine.set_resolution(params.scale);
    engine.set_mode(params.mode);
    engine.set_intensity(params.intensity);
    engine.set_hue(params.hue);
    engine.reseed(params.seed);
    engine.set_pointer(params.pointerX, params.pointerY, params.pointerDown ? 1 : 0);

    const sum = engine.render_band(params.elapsedMs, y0, y1);
    const width = engine.width();
    const height = engine.height();

    // Copy out of wasm memory: the memory itself cannot be transferred, but the
    // copy can, so the main thread receives it without a second copy.
    const bytes = new Uint8Array(
      engine.memory.buffer,
      engine.framebuffer_ptr() + y0 * width * 4,
      (y1 - y0) * width * 4
    ).slice();

    scope.postMessage(
      { type: "band", id, y0, y1, width, height, sum, bytes: bytes.buffer },
      [bytes.buffer]
    );
  } catch (error) {
    scope.postMessage({ type: "band-error", id: request.id, error: describe(error) });
  }
};

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
