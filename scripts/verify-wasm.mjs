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
  "max_width",
  "max_height",
  "mode_count",
  "set_resolution",
  "framebuffer_ptr",
  "render",
  "flux",
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

const MIN_SCALE = 2;
const MAX_SCALE = 8;
const TILE_WIDTH = 160;
const TILE_HEIGHT = 98;
const MODE_COUNT = 8;

if (engine.mode_count() !== MODE_COUNT) {
  throw new Error(`Engine reports ${engine.mode_count()} modes, expected ${MODE_COUNT}.`);
}

if (engine.max_width() !== TILE_WIDTH * MAX_SCALE || engine.max_height() !== TILE_HEIGHT * MAX_SCALE) {
  throw new Error(
    `Unexpected maximum resolution: ${engine.max_width()}x${engine.max_height()}`
  );
}

// The scale ladder is the contract the adaptive controller and the PNG exporter
// both rely on, so walk every rung and prove the engine reports back exactly the
// geometry the control surface will allocate views against.
for (let scale = MIN_SCALE; scale <= MAX_SCALE; scale += 1) {
  const applied = engine.set_resolution(scale);

  if (applied !== scale) {
    throw new Error(`set_resolution(${scale}) reported ${applied}.`);
  }

  const tierWidth = engine.width();
  const tierHeight = engine.height();

  if (tierWidth !== TILE_WIDTH * scale || tierHeight !== TILE_HEIGHT * scale) {
    throw new Error(`Scale ${scale} produced ${tierWidth}x${tierHeight}.`);
  }

  const tierPointer = engine.framebuffer_ptr();
  const tierLength = tierWidth * tierHeight * 4;

  if (tierPointer < 0 || tierPointer + tierLength > engine.memory.buffer.byteLength) {
    throw new Error(`Scale ${scale} framebuffer points outside WASM memory.`);
  }

  // Every tier must render a complete, opaque frame — a partially written
  // buffer would surface as torn edges only at that one quality setting.
  engine.set_mode(0);
  engine.set_intensity(0.9);
  engine.reseed(1770);
  engine.render(1500);
  const tierFrame = new Uint8Array(engine.memory.buffer, tierPointer, tierLength);

  for (let index = 3; index < tierFrame.length; index += 4) {
    if (tierFrame[index] !== 255) {
      throw new Error(`Scale ${scale} left byte ${index} non-opaque.`);
    }
  }
}

if (engine.set_resolution(0) !== MIN_SCALE || engine.set_resolution(9999) !== MAX_SCALE) {
  throw new Error("set_resolution does not clamp out-of-range scales.");
}

// Run the renderer checks below at the default preview tier.
engine.set_resolution(MIN_SCALE);
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
const wrappedMode = renderScenario({ ...baselineInput, mode: MODE_COUNT + 2 });
const explicitWrappedMode = renderScenario({ ...baselineInput, mode: 2 });
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

// Each palette/field pairing is a separate code path; a mode that silently
// aliased another would still pass a two-mode comparison.
const modeFrames = [];

for (let mode = 0; mode < MODE_COUNT; mode += 1) {
  const rendered = renderScenario({ ...baselineInput, mode });

  if (rendered.coverage < 0.1) {
    throw new Error(`Mode ${mode} rendered an unlit frame (coverage ${rendered.coverage}).`);
  }

  modeFrames.push(rendered);
}

for (let left = 0; left < MODE_COUNT; left += 1) {
  for (let right = left + 1; right < MODE_COUNT; right += 1) {
    const delta = differenceRatio(modeFrames[left].frame, modeFrames[right].frame);

    if (delta < 0.2) {
      throw new Error(`Modes ${left} and ${right} differ on only ${(delta * 100).toFixed(1)}% of pixels.`);
    }
  }
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

// Flux is live telemetry the control surface renders as a meter, so the ABI
// check has to prove it is a real readback of the last frame rather than a
// constant: it must stay inside the exposure clamp and follow intensity.
engine.set_mode(0);
engine.reseed(1770);

engine.set_intensity(0.15);
engine.render(900);
const dimFlux = engine.flux();

engine.set_intensity(1.35);
engine.render(900);
const brightFlux = engine.flux();

for (const [label, value] of [
  ["dim", dimFlux],
  ["bright", brightFlux]
]) {
  if (!Number.isFinite(value) || value < 0 || value > 1.6) {
    throw new Error(`Flux telemetry (${label}) left the exposure range: ${value}`);
  }
}

if (!(brightFlux > dimFlux)) {
  throw new Error(
    `Flux telemetry does not track intensity (dim=${dimFlux}, bright=${brightFlux}).`
  );
}

console.log(
  `Verified WASM ABI across scales ${MIN_SCALE}-${MAX_SCALE} ` +
    `(up to ${engine.max_width()}x${engine.max_height()}), ` +
    `${MODE_COUNT} distinct modes, and the ${width}x${height} renderer: ` +
    `${Math.round(baseline.coverage * 100)}% lit, ` +
    `${Math.round(modeDifference * 100)}% mode delta, ` +
    `${Math.round(seedDifference * 100)}% seed delta, ` +
    `${Math.round(adjacentHighSeedDifference * 100)}% adjacent-u32 delta, ` +
    `checksum ${baseline.checksum}, ` +
    `flux ${dimFlux.toFixed(3)}->${brightFlux.toFixed(3)}.`
);
