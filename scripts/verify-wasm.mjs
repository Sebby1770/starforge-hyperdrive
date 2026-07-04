import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmPath = join(rootDir, "web", "public", "starforge_hyperdrive.wasm");
const bytes = await readFile(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const engine = instance.exports;

const requiredExports = [
  "memory",
  "width",
  "height",
  "framebuffer_ptr",
  "render",
  "set_pointer",
  "set_mode",
  "set_intensity",
  "reseed"
];

for (const name of requiredExports) {
  if (!(name in engine)) {
    throw new Error(`Missing WASM export: ${name}`);
  }
}

function verifyFrame(mode, seed) {
  engine.reseed(seed);
  engine.set_mode(mode);
  engine.set_intensity(0.94);
  engine.set_pointer(0.18, -0.24, 1);
  engine.render(2400 + mode * 120);

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

    checksum = (checksum + energy * (index + 17 + mode)) >>> 0;
  }

  const coverage = litPixels / (width * height);

  if (coverage < 0.18 || checksum === 0) {
    throw new Error(
      `Mode ${mode} verification failed: coverage=${coverage.toFixed(3)} checksum=${checksum}`
    );
  }

  return { width, height, coverage, checksum };
}

const results = [0, 1, 2, 3].map((mode) => verifyFrame(mode, 1770 + mode));
const first = results[0];

console.log(
  `Verified ${first.width}x${first.height} WASM frame across 4 modes. ` +
    `Coverage ${Math.round(first.coverage * 100)}%, checksum ${first.checksum}.`
);