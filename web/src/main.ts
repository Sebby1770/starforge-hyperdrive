import "./styles.css";
import { isInteractiveShortcutTarget } from "./keyboard";
import { initSpotlightCards, initUiChrome } from "./effects";
import { createRenderer, type RenderMetrics } from "./renderer";
import { createDriveAudio } from "./drive-audio";
import {
  ADAPTIVE_SCALES,
  DEFAULT_STATE,
  EXPORT_SCALE,
  MAX_HUE,
  MAX_INTENSITY,
  MAX_SEED,
  MAX_SPEED,
  MIN_HUE,
  MIN_INTENSITY,
  MIN_SPEED,
  MODES,
  PRESETS,
  TIER_SCALES,
  boundedInteger,
  instrumentSearchParams,
  nextAdaptiveScale,
  normaliseState,
  parseInstrumentState,
  resolutionForScale,
  type InstrumentState,
  type QualityTier
} from "./instrument-state";

type StarforgeExports = {
  memory: WebAssembly.Memory;
  width: () => number;
  height: () => number;
  max_width: () => number;
  max_height: () => number;
  mode_count: () => number;
  set_resolution: (scale: number) => number;
  framebuffer_ptr: () => number;
  render: (elapsedMs: number) => void;
  flux: () => number;
  set_pointer: (x: number, y: number, down: number) => void;
  set_mode: (mode: number) => void;
  set_intensity: (value: number) => void;
  set_hue: (value: number) => void;
  reseed: (value: number) => void;
};

type StateUpdateOptions = {
  announce?: string;
  syncUrl?: boolean;
};

const TARGET_FRAME_MS = 1000 / 45;

/**
 * Engine frame cost the adaptive controller aims to stay under.
 *
 * Deliberately below `TARGET_FRAME_MS` so the browser keeps headroom for the
 * texture upload, compositing, and everything else sharing the main thread.
 */
const ADAPTIVE_BUDGET_MS = 16;

/** Consecutive samples required before the adaptive tier is allowed to move. */
const ADAPTIVE_SAMPLE_WINDOW = 30;

/**
 * Tier used for a held frame while quality is automatic.
 *
 * A paused instrument has no frame rate to protect, so the budget that governs
 * playback does not apply: one slower render buys a visibly sharper still, which
 * is the state people actually screenshot and export from.
 */
const STILL_SCALE = 4;

const app = requiredElement<HTMLElement>("#app");
const canvas = requiredElement<HTMLCanvasElement>("#starfield");
const fpsDisplay = requiredElement<HTMLElement>("#fps");
const fluxDisplay = requiredElement<HTMLElement>("#flux");
const renderDisplay = requiredElement<HTMLElement>("#render-ms");
const backendDisplay = requiredElement<HTMLElement>("#backend");
const resolutionDisplay = requiredElement<HTMLElement>("#resolution");
const motionDisplay = requiredElement<HTMLElement>("#motion-state");
const statusDisplay = requiredElement<HTMLElement>("#status");
const intensityInput = requiredElement<HTMLInputElement>("#intensity");
const intensityOutput = requiredElement<HTMLOutputElement>("#intensity-output");
const speedInput = requiredElement<HTMLInputElement>("#speed");
const speedOutput = requiredElement<HTMLOutputElement>("#speed-output");
const hueInput = requiredElement<HTMLInputElement>("#hue");
const hueOutput = requiredElement<HTMLOutputElement>("#hue-output");
const driveAudioButton = requiredElement<HTMLButtonElement>("#drive-audio");
const driveAudioLabel = requiredElement<HTMLElement>("#drive-audio-label");
const driveAudio = createDriveAudio(true);
const qualitySelect = requiredElement<HTMLSelectElement>("#quality");
const seedInput = requiredElement<HTMLInputElement>("#seed");
const shuffleButton = requiredElement<HTMLButtonElement>("#shuffle");
const playbackButton = requiredElement<HTMLButtonElement>("#playback");
const playbackLabel = requiredElement<HTMLElement>("#playback-label");
const copyLinkButton = requiredElement<HTMLButtonElement>("#copy-link");
const exportButton = requiredElement<HTMLButtonElement>("#export-png");
const fullscreenButton = requiredElement<HTMLButtonElement>("#fullscreen");
const fullscreenLabel = requiredElement<HTMLElement>("#fullscreen-label");
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".mode-button"));
const presetButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".preset-button"));
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

let renderer: ReturnType<typeof createRenderer>;

try {
  renderer = createRenderer(canvas);
} catch (error) {
  showFatalError("This browser cannot create the WebGL or 2D canvas Starforge needs.");
  throw error;
}

const activeRenderer = renderer;
let lastMetrics: RenderMetrics = {
  backend: activeRenderer.backend,
  uploadMs: 0,
  drawMs: 0
};

let instrumentState = readUrlState();
let isPlaying = !reducedMotionQuery.matches;
let pointerDown = false;
let animationFrameId: number | null = null;
let simulationTime = reducedMotionQuery.matches ? 2400 : 0;
let lastPaintAt = performance.now();
let lastMeterUpdate = 0;
let fpsAverage = 45;
let engineMsAverage = 0;
let adaptiveSamples = 0;

/**
 * Tier the adaptive controller has settled on for playback.
 *
 * Tracked separately from `activeScale` because pausing and exporting both move
 * the engine off it temporarily, and resuming has to come back to the measured
 * tier rather than to whatever the last render happened to use.
 */
let adaptiveScale = 0;

syncControls();
syncDriveAudioUi();

let wasm: StarforgeExports;

try {
  wasm = await loadWasm();
} catch (error) {
  const detail = error instanceof Error ? error.message : "Unknown WebAssembly error.";
  showFatalError(`Starforge could not ignite: ${detail}`);
  throw error;
}

let activeScale = 0;
let width = 0;
let height = 0;
let bufferSize = 0;
let framebuffer = new Uint8ClampedArray(0);

applyScale(initialScale());
adaptiveScale = activeScale;

if (!isPlaying && instrumentState.quality === "auto") {
  applyScale(STILL_SCALE);
}

backendDisplay.textContent = activeRenderer.backend === "webgl" ? "WebGL2" : "Canvas2D";

initUiChrome();
initSpotlightCards();

applyEngineState();
writeUrlState();
fitCanvas();
paintFrame();
updateTelemetry();
syncPlaybackUi();
syncFullscreenUi();
app.setAttribute("aria-busy", "false");

if (isPlaying) {
  startAnimation();
  setStatus("Drive online. Move across the field or use the controls to shape it.");
} else {
  setStatus("Reduced motion detected. The field is paused; press Play to animate it.");
}

window.addEventListener("resize", fitCanvas, { passive: true });
window.addEventListener("popstate", () => {
  updateInstrumentState(readUrlState(), {
    announce: "Shared instrument state restored.",
    syncUrl: false
  });
});

canvas.addEventListener("pointermove", sendPointer);
canvas.addEventListener("pointerdown", (event) => {
  pointerDown = true;
  canvas.setPointerCapture(event.pointerId);
  sendPointer(event);
});
canvas.addEventListener("pointerup", (event) => {
  pointerDown = false;
  sendPointer(event);

  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
});
canvas.addEventListener("pointercancel", resetPointer);
canvas.addEventListener("pointerleave", () => {
  if (!pointerDown) {
    wasm.set_pointer(0, 0, 0);
    paintFrameIfPaused();
  }
});

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const mode = Number(button.dataset.mode);

    if (!Number.isInteger(mode)) {
      return;
    }

    selectMode(mode);
  });
});

presetButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const preset = PRESETS.find((candidate) => candidate.id === button.dataset.preset);

    if (!preset) {
      return;
    }

    updateInstrumentState(
      { ...instrumentState, ...preset.state },
      { announce: `${preset.name} preset loaded.` }
    );
  });
});

intensityInput.addEventListener("input", () => {
  const intensity = boundedInteger(
    intensityInput.value,
    MIN_INTENSITY,
    MAX_INTENSITY,
    instrumentState.intensity
  );
  updateInstrumentState({ ...instrumentState, intensity });
});

speedInput.addEventListener("input", () => {
  const speed = boundedInteger(speedInput.value, MIN_SPEED, MAX_SPEED, instrumentState.speed);
  updateInstrumentState({ ...instrumentState, speed });
});

hueInput.addEventListener("input", () => {
  const hue = boundedInteger(hueInput.value, MIN_HUE, MAX_HUE, instrumentState.hue);
  updateInstrumentState({ ...instrumentState, hue });
});

driveAudioButton.addEventListener("click", () => {
  driveAudio.setMuted(!driveAudio.muted);
  syncDriveAudioUi();
  setStatus(driveAudio.muted ? "Drive audio off." : "Drive audio following flux.");
});

qualitySelect.addEventListener("change", () => {
  updateInstrumentState(
    { ...instrumentState, quality: qualitySelect.value as QualityTier },
    { announce: `${qualitySelect.value} quality selected.` }
  );
});

seedInput.addEventListener("change", applySeedInput);
seedInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    applySeedInput();
    seedInput.select();
  }
});

shuffleButton.addEventListener("click", randomiseSeed);
playbackButton.addEventListener("click", () => setPlaying(!isPlaying));
copyLinkButton.addEventListener("click", () => void copyShareLink());
exportButton.addEventListener("click", () => void exportPng());
fullscreenButton.addEventListener("click", () => void toggleFullscreen());

document.addEventListener("fullscreenchange", () => {
  syncFullscreenUi();
  fitCanvas();
});
document.addEventListener("keydown", handleKeyboardShortcut);

reducedMotionQuery.addEventListener("change", (event) => {
  if (event.matches && isPlaying) {
    setPlaying(false, "Reduced motion is now active. The field has been paused.");
  } else if (!event.matches) {
    setStatus("Reduced motion is off. Press Play whenever you want to resume the field.");
  }
});

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Starforge UI is missing ${selector}.`);
  }

  return element;
}

async function loadWasm(): Promise<StarforgeExports> {
  const wasmUrl = `${import.meta.env.BASE_URL}starforge_hyperdrive.wasm`;
  const response = await fetch(wasmUrl);

  if (!response.ok) {
    throw new Error(`Unable to load the engine (${response.status}).`);
  }

  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports as Record<string, unknown>;
  const requiredFunctions: Array<keyof Omit<StarforgeExports, "memory">> = [
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
    "set_hue",
    "reseed"
  ];

  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("The engine did not export WebAssembly memory.");
  }

  for (const name of requiredFunctions) {
    if (typeof exports[name] !== "function") {
      throw new Error(`The engine is missing its ${name} export.`);
    }
  }

  const engine = exports as unknown as StarforgeExports;

  if (engine.mode_count() !== MODES.length) {
    throw new Error(
      `The engine offers ${engine.mode_count()} modes but the interface lists ${MODES.length}.`
    );
  }

  return engine;
}

/**
 * Points the engine at a new render resolution and rebuilds everything that
 * depends on it.
 *
 * The framebuffer view has to be recreated because its byte length changes with
 * the tier, and the renderer needs its texture resized to match.
 */
function applyScale(scale: number) {
  const applied = wasm.set_resolution(scale);
  width = wasm.width();
  height = wasm.height();
  bufferSize = width * height * 4;

  validateFramebufferContract(wasm, width, height, bufferSize);

  activeScale = applied;
  framebuffer = readFramebuffer(wasm, bufferSize);
  activeRenderer.resize(width, height);
  resolutionDisplay.textContent = `${width}×${height}`;
  fitCanvas();
}

/** Resolution to open on, honouring an explicit tier from the share link. */
function initialScale(): number {
  if (instrumentState.quality !== "auto") {
    return TIER_SCALES[instrumentState.quality];
  }

  // Open the adaptive ladder at its floor and climb into whatever headroom the
  // machine turns out to have. Starting higher and demoting would show every
  // visitor a quality drop a second after load.
  return ADAPTIVE_SCALES[0];
}

/** Tier automatic quality should be rendering at right now. */
function autoScaleForPlayback(): number {
  return isPlaying ? adaptiveScale : STILL_SCALE;
}

function validateFramebufferContract(
  engine: StarforgeExports,
  frameWidth: number,
  frameHeight: number,
  frameSize: number
) {
  const pointer = engine.framebuffer_ptr();

  if (
    !Number.isInteger(frameWidth) ||
    !Number.isInteger(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    frameWidth > engine.max_width() ||
    frameHeight > engine.max_height()
  ) {
    throw new Error(`The engine returned invalid dimensions: ${frameWidth}×${frameHeight}.`);
  }

  if (pointer < 0 || pointer + frameSize > engine.memory.buffer.byteLength) {
    throw new Error("The engine framebuffer points outside WebAssembly memory.");
  }
}

function readFramebuffer(engine: StarforgeExports, frameSize: number) {
  return new Uint8ClampedArray(engine.memory.buffer, engine.framebuffer_ptr(), frameSize);
}

function frame(now: number) {
  if (!isPlaying) {
    animationFrameId = null;
    return;
  }

  const delta = now - lastPaintAt;

  if (delta >= TARGET_FRAME_MS) {
    simulationTime += Math.min(delta, 100) * (instrumentState.speed / 100);
    lastPaintAt = now;
    fpsAverage = fpsAverage * 0.9 + (1000 / Math.max(delta, 1)) * 0.1;
    paintFrame();
    considerAdaptiveScale();

    if (now - lastMeterUpdate > 250) {
      fpsDisplay.textContent = String(Math.round(fpsAverage));
      updateTelemetry();
      lastMeterUpdate = now;
    }
  }

  animationFrameId = requestAnimationFrame(frame);
}

/**
 * Moves the render tier when `auto` quality is selected.
 *
 * Decisions run off a smoothed engine cost over a fixed sample window, so a
 * single stalled frame — a garbage collection, a tab regaining focus — cannot
 * drop the whole instrument a tier.
 */
function considerAdaptiveScale() {
  if (instrumentState.quality !== "auto") {
    return;
  }

  adaptiveSamples += 1;

  if (adaptiveSamples < ADAPTIVE_SAMPLE_WINDOW) {
    return;
  }

  adaptiveSamples = 0;
  const target = nextAdaptiveScale(adaptiveScale, engineMsAverage, ADAPTIVE_BUDGET_MS);

  if (target !== adaptiveScale) {
    const direction = target > adaptiveScale ? "Raised" : "Lowered";
    adaptiveScale = target;
    applyScale(target);
    setStatus(`${direction} render quality to ${width}×${height} to hold a smooth frame rate.`);
  }
}

function paintFrame() {
  const engineStart = performance.now();
  wasm.render(simulationTime);
  const engineMs = performance.now() - engineStart;
  engineMsAverage = engineMsAverage === 0 ? engineMs : engineMsAverage * 0.85 + engineMs * 0.15;

  // WebAssembly.Memory.grow() detaches the old ArrayBuffer, so the view has to
  // be rebuilt whenever the engine has moved its heap underneath us.
  if (framebuffer.buffer !== wasm.memory.buffer) {
    framebuffer = readFramebuffer(wasm, bufferSize);
  }

  lastMetrics = activeRenderer.draw(framebuffer, width, height);
}

/**
 * Mirrors engine + renderer telemetry into the meter cluster.
 *
 * Flux is read back from the Rust engine (mean per-pixel exposure of the frame
 * that was just drawn) rather than echoing the intensity slider, so it responds
 * to mode, seed, and pointer gravity as well as exposure.
 */
function updateTelemetry() {
  const flux = wasm.flux();
  driveAudio.setFlux(flux, instrumentState.intensity / 100);
  fluxDisplay.textContent = Number.isFinite(flux) ? `${Math.round((flux / 1.6) * 100)}%` : "—";
  renderDisplay.textContent = `${(engineMsAverage + lastMetrics.uploadMs + lastMetrics.drawMs).toFixed(2)} ms`;
}

function paintFrameIfPaused() {
  if (!isPlaying) {
    paintFrame();
    updateTelemetry();
  }
}

function applyEngineState() {
  wasm.set_mode(instrumentState.mode);
  wasm.set_intensity(instrumentState.intensity / 100);
  wasm.set_hue(instrumentState.hue / 360);
  wasm.reseed(instrumentState.seed);
}

function updateInstrumentState(nextState: InstrumentState, options: StateUpdateOptions = {}) {
  const previousQuality = instrumentState.quality;
  instrumentState = normaliseState(nextState);
  applyEngineState();

  if (instrumentState.quality !== previousQuality) {
    adaptiveSamples = 0;

    if (instrumentState.quality === "auto") {
      adaptiveScale = ADAPTIVE_SCALES[0];
      applyScale(autoScaleForPlayback());
    } else {
      applyScale(TIER_SCALES[instrumentState.quality]);
    }
  }

  syncControls();
  paintFrame();
  updateTelemetry();

  if (options.syncUrl !== false) {
    writeUrlState();
  }

  if (options.announce) {
    setStatus(options.announce);
  }
}

function readUrlState(): InstrumentState {
  return parseInstrumentState(window.location.search);
}

function stateUrl() {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.search = instrumentSearchParams(instrumentState).toString();
  return url;
}

function writeUrlState() {
  const url = stateUrl();
  window.history.replaceState(null, "", url);
}

function syncControls() {
  intensityInput.value = String(instrumentState.intensity);
  intensityOutput.value = `${instrumentState.intensity}%`;
  intensityInput.setAttribute("aria-valuetext", `${instrumentState.intensity} percent`);
  speedInput.value = String(instrumentState.speed);
  speedOutput.value = `${instrumentState.speed}%`;
  speedInput.setAttribute("aria-valuetext", `${instrumentState.speed} percent`);
  hueInput.value = String(instrumentState.hue);
  hueOutput.value = `${instrumentState.hue}°`;
  hueInput.setAttribute("aria-valuetext", `${instrumentState.hue} degrees`);
  qualitySelect.value = instrumentState.quality;
  seedInput.value = String(instrumentState.seed);
  canvas.setAttribute(
    "aria-label",
    `Interactive Rust-generated ${MODES[instrumentState.mode]} starfield, seed ${instrumentState.seed}`
  );

  modeButtons.forEach((button) => {
    const active = Number(button.dataset.mode) === instrumentState.mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function selectMode(mode: number) {
  if (mode < 0 || mode >= MODES.length || mode === instrumentState.mode) {
    return;
  }

  updateInstrumentState(
    { ...instrumentState, mode },
    { announce: `${MODES[mode]} field selected.` }
  );
}

function applySeedInput() {
  const seed = boundedInteger(seedInput.value, 0, MAX_SEED, instrumentState.seed);
  updateInstrumentState({ ...instrumentState, seed }, { announce: `System seed ${seed} loaded.` });
}

function randomiseSeed() {
  const values = new Uint32Array(1);
  window.crypto.getRandomValues(values);
  const seed = values[0] ?? DEFAULT_STATE.seed;
  updateInstrumentState(
    { ...instrumentState, seed },
    { announce: `New system seed ${seed} generated.` }
  );
}

function setPlaying(nextPlaying: boolean, message?: string) {
  if (nextPlaying === isPlaying) {
    return;
  }

  isPlaying = nextPlaying;

  if (isPlaying) {
    startAnimation();
  } else if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    fpsDisplay.textContent = "—";
  }

  if (instrumentState.quality === "auto") {
    adaptiveSamples = 0;
    const target = autoScaleForPlayback();

    if (target !== activeScale) {
      applyScale(target);
    }
  }

  paintFrame();
  updateTelemetry();
  syncPlaybackUi();
  setStatus(message ?? (isPlaying ? "Drive resumed." : "Drive paused on the current frame."));
}

function startAnimation() {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
  }

  lastPaintAt = performance.now();
  animationFrameId = requestAnimationFrame(frame);
}

function syncPlaybackUi() {
  playbackLabel.textContent = isPlaying ? "Pause" : "Play";
  playbackButton.setAttribute("aria-label", isPlaying ? "Pause animation" : "Play animation");
  playbackButton.removeAttribute("aria-pressed");
  motionDisplay.textContent = isPlaying ? "Cruising" : "Paused";
  app.classList.toggle("is-paused", !isPlaying);
}

async function copyShareLink() {
  const url = stateUrl().toString();
  writeUrlState();

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      fallbackCopy(url);
    }

    setStatus("Share link copied. It preserves mode, intensity, seed, and speed.");
  } catch {
    try {
      fallbackCopy(url);
      setStatus("Share link copied. It preserves mode, intensity, seed, and speed.");
    } catch {
      setStatus("The link could not be copied automatically. Copy it from the address bar.", true);
    }
  }
}

function fallbackCopy(value: string) {
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();

  if (!copied) {
    throw new Error("Legacy clipboard copy failed.");
  }
}

/**
 * Exports the current composition as a PNG rendered natively at export scale.
 *
 * Earlier releases upscaled the on-screen canvas, so the saved file carried the
 * preview tier's detail stretched over four times the pixels. Re-rendering the
 * same state through the engine at `EXPORT_SCALE` produces genuinely new
 * samples, and costs one frame rather than a sustained frame-rate hit because
 * the tier is restored immediately afterwards.
 */
async function exportPng() {
  exportButton.disabled = true;
  const { width: exportWidth, height: exportHeight } = resolutionForScale(EXPORT_SCALE);
  setStatus(`Rendering a native ${exportWidth}×${exportHeight} PNG…`);

  const restoreScale = activeScale;

  try {
    // Yield once so the status update paints before the export frame blocks the
    // main thread.
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    applyScale(EXPORT_SCALE);
    wasm.render(simulationTime);

    const exportBuffer = readFramebuffer(wasm, width * height * 4);
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = width;
    exportCanvas.height = height;
    const exportContext = exportCanvas.getContext("2d", { alpha: false });

    if (!exportContext) {
      throw new Error("Export canvas unavailable.");
    }

    const image = new ImageData(width, height);
    image.data.set(exportBuffer);
    exportContext.putImageData(image, 0, 0);

    const blob = await canvasBlob(exportCanvas);
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `starforge-${MODES[instrumentState.mode].toLowerCase()}-${instrumentState.seed}.png`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    setStatus(`PNG exported at a native ${exportCanvas.width}×${exportCanvas.height}.`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown export error.";
    setStatus(`PNG export failed: ${detail}`, true);
  } finally {
    // Always come back to the preview tier, including after a failed export, so
    // a thrown error cannot strand the instrument at export resolution.
    applyScale(restoreScale);
    paintFrame();
    exportButton.disabled = false;
  }
}

function canvasBlob(source: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    source.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("The browser returned an empty image."));
      }
    }, "image/png");
  });
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await app.requestFullscreen();
    }
  } catch {
    setStatus("Fullscreen could not be changed in this browser.", true);
  }
}

function syncFullscreenUi() {
  const fullscreen = document.fullscreenElement === app;
  fullscreenLabel.textContent = fullscreen ? "Exit full" : "Fullscreen";
  fullscreenButton.setAttribute("aria-pressed", String(fullscreen));
  fullscreenButton.setAttribute("aria-label", fullscreen ? "Exit fullscreen" : "Enter fullscreen");
}

function handleKeyboardShortcut(event: KeyboardEvent) {
  if (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    isInteractiveShortcutTarget(event.target) ||
    isInteractiveShortcutTarget(document.activeElement)
  ) {
    return;
  }

  const key = event.key.toLowerCase();

  if (key === " " || key === "spacebar") {
    event.preventDefault();
    setPlaying(!isPlaying);
  } else if (key === "r") {
    event.preventDefault();
    randomiseSeed();
  } else if (key === "c") {
    event.preventDefault();
    void copyShareLink();
  } else if (key === "e") {
    event.preventDefault();
    void exportPng();
  } else if (key === "f") {
    event.preventDefault();
    void toggleFullscreen();
  } else if (/^[1-9]$/.test(key)) {
    event.preventDefault();
    selectMode(Number(key) - 1);
  } else if (key === "0") {
    event.preventDefault();
    selectMode(9);
  } else if (key === "-" || key === "_") {
    event.preventDefault();
    selectMode(10);
  } else if (key === "=" || key === "+") {
    event.preventDefault();
    selectMode(11);
  } else if (key === "m") {
    event.preventDefault();
    driveAudio.setMuted(!driveAudio.muted);
    syncDriveAudioUi();
    setStatus(driveAudio.muted ? "Drive audio off." : "Drive audio following flux.");
  }
}

function syncDriveAudioUi() {
  driveAudioLabel.textContent = driveAudio.muted ? "Audio off" : "Audio on";
  driveAudioButton.setAttribute("aria-pressed", String(!driveAudio.muted));
}

function sendPointer(event: PointerEvent) {
  const rect = canvas.getBoundingClientRect();

  if (rect.width === 0 || rect.height === 0) {
    return;
  }

  const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2 * (width / height);
  const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
  wasm.set_pointer(x, y, pointerDown ? 1 : 0);
  paintFrameIfPaused();
}

function resetPointer() {
  pointerDown = false;
  wasm.set_pointer(0, 0, 0);
  paintFrameIfPaused();
}

function fitCanvas() {
  if (width === 0 || height === 0) {
    return;
  }

  const scale = Math.max(app.clientWidth / width, app.clientHeight / height);
  canvas.style.width = `${Math.ceil(width * scale)}px`;
  canvas.style.height = `${Math.ceil(height * scale)}px`;
}

function setStatus(message: string, isError = false) {
  statusDisplay.textContent = message;
  statusDisplay.classList.toggle("is-error", isError);
}

function showFatalError(message: string) {
  app.setAttribute("aria-busy", "false");
  app.classList.add("engine-failed");
  setStatus(message, true);
}
