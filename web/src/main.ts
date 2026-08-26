import "./styles.css";
import { isInteractiveShortcutTarget } from "./keyboard";
import { initSpotlightCards, initUiChrome } from "./effects";
import { createRenderer, type RenderMetrics } from "./renderer";
import {
  DEFAULT_STATE,
  MAX_INTENSITY,
  MAX_SEED,
  MIN_INTENSITY,
  MODES,
  boundedInteger,
  instrumentSearchParams,
  normaliseState,
  parseInstrumentState,
  type InstrumentState
} from "./instrument-state";

type StarforgeExports = {
  memory: WebAssembly.Memory;
  width: () => number;
  height: () => number;
  framebuffer_ptr: () => number;
  render: (elapsedMs: number) => void;
  flux: () => number;
  set_pointer: (x: number, y: number, down: number) => void;
  set_mode: (mode: number) => void;
  set_intensity: (value: number) => void;
  reseed: (value: number) => void;
};

type StateUpdateOptions = {
  announce?: string;
  syncUrl?: boolean;
};

const TARGET_FRAME_MS = 1000 / 45;
const EXPORT_SCALE = 4;

const app = requiredElement<HTMLElement>("#app");
const canvas = requiredElement<HTMLCanvasElement>("#starfield");
const fpsDisplay = requiredElement<HTMLElement>("#fps");
const fluxDisplay = requiredElement<HTMLElement>("#flux");
const renderDisplay = requiredElement<HTMLElement>("#render-ms");
const backendDisplay = requiredElement<HTMLElement>("#backend");
const motionDisplay = requiredElement<HTMLElement>("#motion-state");
const statusDisplay = requiredElement<HTMLElement>("#status");
const intensityInput = requiredElement<HTMLInputElement>("#intensity");
const intensityOutput = requiredElement<HTMLOutputElement>("#intensity-output");
const seedInput = requiredElement<HTMLInputElement>("#seed");
const shuffleButton = requiredElement<HTMLButtonElement>("#shuffle");
const playbackButton = requiredElement<HTMLButtonElement>("#playback");
const playbackLabel = requiredElement<HTMLElement>("#playback-label");
const copyLinkButton = requiredElement<HTMLButtonElement>("#copy-link");
const exportButton = requiredElement<HTMLButtonElement>("#export-png");
const fullscreenButton = requiredElement<HTMLButtonElement>("#fullscreen");
const fullscreenLabel = requiredElement<HTMLElement>("#fullscreen-label");
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".mode-button"));
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

syncControls();

let wasm: StarforgeExports;

try {
  wasm = await loadWasm();
} catch (error) {
  const detail = error instanceof Error ? error.message : "Unknown WebAssembly error.";
  showFatalError(`Starforge could not ignite: ${detail}`);
  throw error;
}

const width = wasm.width();
const height = wasm.height();
const bufferSize = width * height * 4;
validateFramebufferContract(wasm, width, height, bufferSize);

activeRenderer.resize(width, height);
backendDisplay.textContent = activeRenderer.backend === "webgl" ? "WebGL2" : "Canvas2D";

let framebuffer = readFramebuffer(wasm, bufferSize);

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

intensityInput.addEventListener("input", () => {
  const intensity = boundedInteger(
    intensityInput.value,
    MIN_INTENSITY,
    MAX_INTENSITY,
    instrumentState.intensity
  );
  updateInstrumentState({ ...instrumentState, intensity });
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
    "framebuffer_ptr",
    "render",
    "flux",
    "set_pointer",
    "set_mode",
    "set_intensity",
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

  return exports as unknown as StarforgeExports;
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
    frameWidth > 4096 ||
    frameHeight > 4096
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
    simulationTime += Math.min(delta, 100);
    lastPaintAt = now;
    fpsAverage = fpsAverage * 0.9 + (1000 / Math.max(delta, 1)) * 0.1;
    paintFrame();

    if (now - lastMeterUpdate > 250) {
      fpsDisplay.textContent = String(Math.round(fpsAverage));
      updateTelemetry();
      lastMeterUpdate = now;
    }
  }

  animationFrameId = requestAnimationFrame(frame);
}

function startAnimation() {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
  }

  lastPaintAt = performance.now();
  animationFrameId = requestAnimationFrame(frame);
}

function paintFrame() {
  wasm.render(simulationTime);

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
  fluxDisplay.textContent = Number.isFinite(flux) ? `${Math.round((flux / 1.6) * 100)}%` : "—";
  renderDisplay.textContent = `${(lastMetrics.uploadMs + lastMetrics.drawMs).toFixed(2)} ms`;
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
  wasm.reseed(instrumentState.seed);
}

function updateInstrumentState(nextState: InstrumentState, options: StateUpdateOptions = {}) {
  instrumentState = normaliseState(nextState);
  applyEngineState();
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
  updateInstrumentState(
    { ...instrumentState, seed },
    { announce: `System seed ${seed} loaded.` }
  );
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

  syncPlaybackUi();
  setStatus(message ?? (isPlaying ? "Drive resumed." : "Drive paused on the current frame."));
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

    setStatus("Share link copied. It preserves mode, intensity, and seed.");
  } catch {
    try {
      fallbackCopy(url);
      setStatus("Share link copied. It preserves mode, intensity, and seed.");
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

async function exportPng() {
  exportButton.disabled = true;
  setStatus("Rendering a high-resolution PNG…");

  try {
    paintFrame();
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = width * EXPORT_SCALE;
    exportCanvas.height = height * EXPORT_SCALE;
    const exportContext = exportCanvas.getContext("2d", { alpha: false });

    if (!exportContext) {
      throw new Error("Export canvas unavailable.");
    }

    exportContext.imageSmoothingEnabled = true;
    exportContext.imageSmoothingQuality = "high";
    exportContext.drawImage(canvas, 0, 0, exportCanvas.width, exportCanvas.height);
    const blob = await canvasBlob(exportCanvas);
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `starforge-${MODES[instrumentState.mode].toLowerCase()}-${instrumentState.seed}.png`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    setStatus(`PNG exported at ${exportCanvas.width}×${exportCanvas.height}.`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown export error.";
    setStatus(`PNG export failed: ${detail}`, true);
  } finally {
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
  } else if (/^[1-4]$/.test(key)) {
    event.preventDefault();
    selectMode(Number(key) - 1);
  }
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
