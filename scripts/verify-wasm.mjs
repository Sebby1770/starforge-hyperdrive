import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmPath = join(rootDir, "web", "public", "starforge_hyperdrive.wasm");
const bytes = await readFile(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const engine = instance.exports;

engine.reseed(1770);
engine.set_mode(2);
engine.set_intensity(0.94);
engine.set_pointer(0.18, -0.24, 1);
engine.render(2400);

const width = engine.width();
const height = engine.height();
const frame = new Uint8Array(engine.memory.buffer, engine.framebuffer_ptr(), width * height * 4);
let litPixels = 0;
let checksum = 0;

for (let index = 0; index < frame.length; index += 4) {
  const energy = frame[index] + frame[index + 1] + frame[index + 2];

  if (energy > 18) {
    litPixels += 1;
  }

  checksum = (checksum + energy * (index + 17)) >>> 0;
}

const coverage = litPixels / (width * height);

if (coverage < 0.18 || checksum === 0) {
  throw new Error(`Frame verification failed: coverage=${coverage.toFixed(3)} checksum=${checksum}`);
}

console.log(`Verified ${width}x${height} WASM frame: ${Math.round(coverage * 100)}% lit, checksum ${checksum}.`);
