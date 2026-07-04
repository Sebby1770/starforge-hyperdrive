import "./styles.css";
import { initSpotlightCards, initUiChrome } from "./effects";
import { createRenderer, type RenderBackend, type RenderMetrics } from "./renderer";

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

const canvas = document.querySelector<HTMLCanvasElement>("#starfield");
const fpsDisplay = document.querySelector<HTMLElement>("#fps");
const fluxDisplay = document.querySelector<HTMLElement>("#flux");
const renderDisplay = document.querySelector<HTMLElement>("#render-ms");
const backendDisplay = document.querySelector<HTMLElement>("#backend");
const intensityDisplay = document.querySelector<HTMLElement>("#intensity-value");
const intensityInput = document.querySelector<HTMLInputElement>("#intensity");
const shuffleButton = document.querySelector<HTMLButtonElement>("#shuffle");
const fullscreenButton = document.querySelector<HTMLButtonElement>("#fullscreen");
const loadingOverlay = document.querySelector<HTMLElement>("#loading-overlay");
const errorPanel = document.querySelector<HTMLElement>("#error-panel");
const retryButton = document.querySelector<HTMLButtonElement>("#retry");
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".mode-button"));

if (
  !canvas ||
  !fpsDisplay ||
  !fluxDisplay ||
  !renderDisplay ||
  !backendDisplay ||
  !intensityDisplay ||
  !intensityInput ||
  !shuffleButton ||
  !fullscreenButton ||
  !loadingOverlay ||
  !errorPanel ||
  !retryButton
) {
  throw new Error("Starforge UI failed to mount.");
}

const starfieldCanvas = canvas;
const fpsNode = fpsDisplay;
const fluxNode = fluxDisplay;
const renderNode = renderDisplay;
const backendNode = backendDisplay;
const intensityNode = intensityDisplay;
const intensityInputEl = intensityInput;
const shuffleButtonEl = shuffleButton;
const fullscreenButtonEl = fullscreenButton;
const loadingNode = loadingOverlay;
const errorNode = errorPanel;
const retryButtonEl = retryButton;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const targetFrameMs = reducedMotion ? 1000 / 15 : 1000 / 45;

let renderer: ReturnType<typeof createRenderer> | null = null;
let wasm: StarforgeExports | null = null;
let width = 0;
let height = 0;
let bufferSize = 0;
let framebuffer = new Uint8ClampedArray();
let pointerDown = false;
let capturedPointerId: number | null = null;
let lastPointer = { x: 0, y: 0 };
let currentMode = 0;
let lastRender = performance.now();
let fpsAverage = 45;
let seed = Date.now() % 100_000;
let animationHandle = 0;
let cleanupEffects: (() => void) | null = null;

void bootstrap();

async function bootstrap() {
  showLoading();
  hideError();

  try {
    renderer = createRenderer(starfieldCanvas);
    wasm = await loadWasm();
    width = wasm.width();
    height = wasm.height();
    bufferSize = width * height * 4;

    renderer.resize(width, height);
    backendNode.textContent = renderer.backend.toUpperCase();

    framebuffer = new Uint8ClampedArray(wasm.memory.buffer, wasm.framebuffer_ptr(), bufferSize);

    wasm.reseed(seed);
    wasm.set_intensity(Number(intensityInputEl.value) / 100);
    intensityNode.textContent = `${intensityInputEl.value}%`;

    syncModeButtons();
    hideLoading();
    setControlsEnabled(true);
    bindControls();
    cleanupEffects?.();
    const stopSpotlight = initSpotlightCards();
    const stopUiChrome = initUiChrome();
    cleanupEffects = () => {
      stopSpotlight();
      stopUiChrome();
    };
    restoreStateFromUrl();

    window.addEventListener("resize", fitCanvas, { passive: true });
    fitCanvas();
    animationHandle = requestAnimationFrame(frame);
  } catch (error) {
    hideLoading();
    setControlsEnabled(false);
    showError(error);
  }
}

function bindControls() {
  starfieldCanvas.addEventListener("pointermove", (event) => {
    if (capturedPointerId === event.pointerId) {
      sendPointer(event);
    }
  });

  starfieldCanvas.addEventListener("pointerdown", (event) => {
    pointerDown = true;
    capturedPointerId = event.pointerId;
    starfieldCanvas.setPointerCapture(event.pointerId);
    sendPointer(event);
  });

  starfieldCanvas.addEventListener("pointerup", releasePointer);
  starfieldCanvas.addEventListener("pointercancel", releasePointer);

  starfieldCanvas.addEventListener("pointerleave", () => {
    if (!pointerDown && wasm) {
      wasm.set_pointer(lastPointer.x, lastPointer.y, 0);
    }
  });

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setMode(Number(button.dataset.mode ?? 0));
    });
  });

  intensityInputEl.addEventListener("input", () => {
    const intensity = Number(intensityInputEl.value);
    wasm?.set_intensity(intensity / 100);
    intensityNode.textContent = `${intensity}%`;
    syncUrlState();
  });

  shuffleButtonEl.addEventListener("click", () => bumpSeed(31));
  fullscreenButtonEl.addEventListener("click", toggleFullscreen);
  retryButtonEl.addEventListener("click", () => {
    cancelAnimationFrame(animationHandle);
    renderer?.destroy();
    void bootstrap();
  });

  window.addEventListener("keydown", handleKeydown);
}

async function loadWasm(): Promise<StarforgeExports> {
  const wasmUrl = `${import.meta.env.BASE_URL}starforge_hyperdrive.wasm`;
  const response = await fetch(wasmUrl);

  if (!response.ok) {
    throw new Error(`Unable to load ${wasmUrl}. Run npm run build:wasm first.`);
  }

  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports as StarforgeExports;
  if (typeof exports.flux !== "function") {
    throw new Error("WASM build is missing the flux() export. Rebuild with npm run build:wasm.");
  }
  return exports;
}

function frame(now: number) {
  if (!wasm || !renderer) {
    return;
  }

  if (now - lastRender < targetFrameMs) {
    animationHandle = requestAnimationFrame(frame);
    return;
  }

  const delta = now - lastRender;
  lastRender = now;
  fpsAverage = fpsAverage * 0.92 + (1000 / Math.max(delta, 1)) * 0.08;

  const renderStart = performance.now();
  wasm.render(now);

  if (framebuffer.buffer !== wasm.memory.buffer) {
    framebuffer = new Uint8ClampedArray(wasm.memory.buffer, wasm.framebuffer_ptr(), bufferSize);
  }

  const metrics = renderer.draw(framebuffer, width, height);
  updateRenderMetrics(metrics, performance.now() - renderStart);
  fluxNode.textContent = `${Math.round(wasm.flux() * 100)}%`;

  if (Math.round(now / 250) % 2 === 0) {
    fpsNode.textContent = String(Math.round(fpsAverage));
  }

  animationHandle = requestAnimationFrame(frame);
}

function updateRenderMetrics(metrics: RenderMetrics, wasmMs: number) {
  renderNode.textContent = `${(wasmMs + metrics.uploadMs + metrics.drawMs).toFixed(1)}ms`;
  backendNode.textContent = labelBackend(metrics.backend);
}

function labelBackend(backend: RenderBackend) {
  return backend === "webgl" ? "WebGL" : "Canvas";
}

function releasePointer(event: PointerEvent) {
  pointerDown = false;
  sendPointer(event);

  if (capturedPointerId === event.pointerId) {
    starfieldCanvas.releasePointerCapture(event.pointerId);
    capturedPointerId = null;
  }
}

function sendPointer(event: PointerEvent) {
  if (!wasm) {
    return;
  }

  const rect = starfieldCanvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2 * (width / height);
  const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
  lastPointer = { x, y };
  wasm.set_pointer(x, y, pointerDown ? 1 : 0);
}

function fitCanvas() {
  const shell = document.querySelector<HTMLElement>(".app-shell");

  if (!shell) {
    return;
  }

  const scale = Math.max(shell.clientWidth / width, shell.clientHeight / height);
  starfieldCanvas.style.width = `${Math.ceil(width * scale)}px`;
  starfieldCanvas.style.height = `${Math.ceil(height * scale)}px`;
}

function setMode(mode: number) {
  if (!wasm) {
    return;
  }

  currentMode = Math.max(0, Math.min(3, mode));
  wasm.set_mode(currentMode);
  syncModeButtons();
  bumpSeed(currentMode + 3);
}

function syncModeButtons() {
  modeButtons.forEach((button) => {
    const active = Number(button.dataset.mode ?? 0) === currentMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function bumpSeed(amount: number) {
  if (!wasm) {
    return;
  }

  seed = (seed + amount * 997 + currentMode * 101) % 100_000;
  wasm.reseed(seed);
  syncUrlState();
}

function handleKeydown(event: KeyboardEvent) {
  if (!wasm || event.target instanceof HTMLInputElement) {
    return;
  }

  switch (event.key) {
    case "1":
    case "2":
    case "3":
    case "4":
      setMode(Number(event.key) - 1);
      event.preventDefault();
      break;
    case " ":
      bumpSeed(31);
      event.preventDefault();
      break;
    case "+":
    case "=":
      adjustIntensity(5);
      event.preventDefault();
      break;
    case "-":
    case "_":
      adjustIntensity(-5);
      event.preventDefault();
      break;
    case "f":
    case "F":
      toggleFullscreen();
      event.preventDefault();
      break;
    default:
      break;
  }
}

function adjustIntensity(delta: number) {
  const next = Math.max(15, Math.min(135, Number(intensityInputEl.value) + delta));
  intensityInputEl.value = String(next);
  wasm?.set_intensity(next / 100);
  intensityNode.textContent = `${next}%`;
  syncUrlState();
}

function toggleFullscreen() {
  const shell = document.querySelector<HTMLElement>(".app-shell");
  if (!shell) {
    return;
  }

  if (document.fullscreenElement) {
    void document.exitFullscreen();
    return;
  }

  void shell.requestFullscreen();
}

function syncUrlState() {
  const params = new URLSearchParams();
  params.set("mode", String(currentMode));
  params.set("intensity", intensityInputEl.value);
  params.set("seed", String(seed));
  history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
}

function restoreStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const mode = Number(params.get("mode"));
  const intensity = Number(params.get("intensity"));
  const urlSeed = Number(params.get("seed"));

  if (!Number.isNaN(mode) && mode >= 0 && mode <= 3) {
    setMode(mode);
  }

  if (!Number.isNaN(intensity) && intensity >= 15 && intensity <= 135) {
    intensityInputEl.value = String(intensity);
    wasm?.set_intensity(intensity / 100);
    intensityNode.textContent = `${intensity}%`;
  }

  if (!Number.isNaN(urlSeed) && urlSeed >= 0) {
    seed = urlSeed % 100_000;
    wasm?.reseed(seed);
  }
}

function setControlsEnabled(enabled: boolean) {
  intensityInputEl.disabled = !enabled;
  shuffleButtonEl.disabled = !enabled;
  fullscreenButtonEl.disabled = !enabled;
  modeButtons.forEach((button) => {
    button.disabled = !enabled;
  });
}

function showLoading() {
  loadingNode.hidden = false;
}

function hideLoading() {
  loadingNode.hidden = true;
}

function showError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error while loading WASM.";
  errorNode.querySelector("p")!.textContent = message;
  errorNode.hidden = false;
}

function hideError() {
  errorNode.hidden = true;
}