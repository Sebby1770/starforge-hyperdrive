import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmPath = join(rootDir, "web", "public", "starforge_hyperdrive.wasm");
const bytes = await readFile(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes, {});
const engine = instance.exports;

const requiredFunctions = [
  "width",
  "height",
  "framebuffer_ptr",
  "render",
  "set_pointer",
  "set_mode",
  "set_intensity",
  "reseed"
];

for (const name of requiredFunctions) {
  if (typeof engine[name] !== "function") {
    throw new Error(`Missing WASM function export: ${name}`);
  }
}

if (!(engine.memory instanceof WebAssembly.Memory)) {
  throw new Error("Missing WASM memory export.");
}

const width = engine.width();
const height = engine.height();
const framebufferPointer = engine.framebuffer_ptr();
const frameLength = width * height * 4;

if (width !== 320 || height !== 196) {
  throw new Error(`Unexpected framebuffer dimensions: ${width}x${height}`);
}

if (framebufferPointer < 0 || framebufferPointer + frameLength > engine.memory.buffer.byteLength) {
  throw new Error("Framebuffer export points outside WASM memory.");
}

function renderScenario({ mode, intensity, seed, pointerX, pointerY, pointerDown, elapsedMs }) {
  engine.reseed(seed);
  engine.set_mode(mode);
  engine.set_intensity(intensity);
  engine.set_pointer(pointerX, pointerY, pointerDown);
  engine.render(elapsedMs);

  const frame = new Uint8Array(
    engine.memory.buffer,
    engine.framebuffer_ptr(),
    frameLength
  ).slice();
  let litPixels = 0;
  let saturatedPixels = 0;
  let checksum = 0;
  let minEnergy = Number.POSITIVE_INFINITY;
  let maxEnergy = 0;

  for (let index = 0; index < frame.length; index += 4) {
    const energy = frame[index] + frame[index + 1] + frame[index + 2];

    if (energy > 18) {
      litPixels += 1;
    }

    if (energy > 744) {
      saturatedPixels += 1;
    }

    if (frame[index + 3] !== 255) {
      throw new Error(`Non-opaque pixel at byte ${index}.`);
    }

    minEnergy = Math.min(minEnergy, energy);
    maxEnergy = Math.max(maxEnergy, energy);
    checksum = (checksum + energy * (index + 17)) >>> 0;
  }

  return {
    frame,
    checksum,
    coverage: litPixels / (width * height),
    saturation: saturatedPixels / (width * height),
    energyRange: maxEnergy - minEnergy
  };
}

function differenceRatio(left, right) {
  let changedPixels = 0;

  for (let index = 0; index < left.length; index += 4) {
    if (
      left[index] !== right[index] ||
      left[index + 1] !== right[index + 1] ||
      left[index + 2] !== right[index + 2]
    ) {
      changedPixels += 1;
    }
  }

  return changedPixels / (width * height);
}

const baselineInput = {
  mode: 2,
  intensity: 0.94,
  seed: 1770,
  pointerX: 0.18,
  pointerY: -0.24,
  pointerDown: 1,
  elapsedMs: 2400
};
const baseline = renderScenario(baselineInput);
const repeated = renderScenario(baselineInput);
const alternateMode = renderScenario({ ...baselineInput, mode: 3 });
const alternateSeed = renderScenario({ ...baselineInput, seed: 42042 });
const wrappedMode = renderScenario({ ...baselineInput, mode: 99 });
const explicitWrappedMode = renderScenario({ ...baselineInput, mode: 3 });
const lowClamp = renderScenario({ ...baselineInput, intensity: -100 });
const explicitLowClamp = renderScenario({ ...baselineInput, intensity: 0.15 });
const penultimateSeed = renderScenario({ ...baselineInput, seed: 4_294_967_294 });
const ultimateSeed = renderScenario({ ...baselineInput, seed: 4_294_967_295 });
const repeatedUltimateSeed = renderScenario({ ...baselineInput, seed: 4_294_967_295 });

if (baseline.coverage < 0.18 || baseline.checksum === 0 || baseline.energyRange < 120) {
  throw new Error(
    `Frame quality failed: coverage=${baseline.coverage.toFixed(3)} ` +
      `range=${baseline.energyRange} checksum=${baseline.checksum}`
  );
}

if (baseline.saturation > 0.98) {
  throw new Error(`Frame is overexposed: saturation=${baseline.saturation.toFixed(3)}`);
}

if (baseline.checksum !== repeated.checksum) {
  throw new Error("Identical renderer inputs did not produce a deterministic frame.");
}

const modeDifference = differenceRatio(baseline.frame, alternateMode.frame);
const seedDifference = differenceRatio(baseline.frame, alternateSeed.frame);
const adjacentHighSeedDifference = differenceRatio(penultimateSeed.frame, ultimateSeed.frame);

if (modeDifference < 0.25 || seedDifference < 0.25 || adjacentHighSeedDifference < 0.25) {
  throw new Error(
    `Renderer controls are not materially distinct: mode=${modeDifference.toFixed(3)} ` +
      `seed=${seedDifference.toFixed(3)} ` +
      `adjacent-high-seed=${adjacentHighSeedDifference.toFixed(3)}`
  );
}

if (ultimateSeed.checksum !== repeatedUltimateSeed.checksum) {
  throw new Error("The maximum u32 seed is not deterministic.");
}

if (wrappedMode.checksum !== explicitWrappedMode.checksum) {
  throw new Error("Mode normalisation changed across equivalent inputs.");
}

if (lowClamp.checksum !== explicitLowClamp.checksum) {
  throw new Error("Intensity lower-bound clamping is inconsistent.");
}

console.log(
  `Verified ${width}x${height} WASM ABI and renderer: ` +
    `${Math.round(baseline.coverage * 100)}% lit, ` +
    `${Math.round(modeDifference * 100)}% mode delta, ` +
    `${Math.round(seedDifference * 100)}% seed delta, ` +
    `${Math.round(adjacentHighSeedDifference * 100)}% adjacent-u32 delta, ` +
    `checksum ${baseline.checksum}.`
);
