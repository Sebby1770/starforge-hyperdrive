import "./styles.css";

type StarforgeExports = {
  memory: WebAssembly.Memory;
  width: () => number;
  height: () => number;
  framebuffer_ptr: () => number;
  render: (elapsedMs: number) => void;
  set_pointer: (x: number, y: number, down: number) => void;
  set_mode: (mode: number) => void;
  set_intensity: (value: number) => void;
  reseed: (value: number) => void;
};

const canvas = document.querySelector<HTMLCanvasElement>("#starfield");
const fpsDisplay = document.querySelector<HTMLElement>("#fps");
const fluxDisplay = document.querySelector<HTMLElement>("#flux");
const intensityInput = document.querySelector<HTMLInputElement>("#intensity");
const shuffleButton = document.querySelector<HTMLButtonElement>("#shuffle");
const modeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".mode-button"));

if (!canvas || !fpsDisplay || !fluxDisplay || !intensityInput || !shuffleButton) {
  throw new Error("Starforge UI failed to mount.");
}

const context = canvas.getContext("2d", {
  alpha: false,
  desynchronized: true
});

if (!context) {
  throw new Error("2D canvas is unavailable.");
}

const starfieldCanvas = canvas;
const renderContext = context;
const fpsNode = fpsDisplay;
const fluxNode = fluxDisplay;
const wasm = await loadWasm();
const width = wasm.width();
const height = wasm.height();
const bufferSize = width * height * 4;

starfieldCanvas.width = width;
starfieldCanvas.height = height;
renderContext.imageSmoothingEnabled = true;

let framebuffer = new Uint8ClampedArray(wasm.memory.buffer, wasm.framebuffer_ptr(), bufferSize);
let imageData = new ImageData(framebuffer, width, height);
let pointerDown = false;
let currentMode = 0;
let lastRender = performance.now();
let fpsAverage = 45;
let seed = Date.now() % 100_000;
const targetFrameMs = 1000 / 45;

wasm.reseed(seed);
wasm.set_intensity(Number(intensityInput.value) / 100);

window.addEventListener("resize", fitCanvas, { passive: true });
fitCanvas();

starfieldCanvas.addEventListener("pointermove", (event) => {
  starfieldCanvas.setPointerCapture(event.pointerId);
  sendPointer(event);
});

starfieldCanvas.addEventListener("pointerdown", (event) => {
  pointerDown = true;
  starfieldCanvas.setPointerCapture(event.pointerId);
  sendPointer(event);
  bumpSeed(7);
});

starfieldCanvas.addEventListener("pointerup", (event) => {
  pointerDown = false;
  sendPointer(event);
});

starfieldCanvas.addEventListener("pointerleave", () => {
  pointerDown = false;
  wasm.set_pointer(0, 0, 0);
});

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    currentMode = Number(button.dataset.mode ?? 0);
    wasm.set_mode(currentMode);
    modeButtons.forEach((item) => item.classList.toggle("active", item === button));
    bumpSeed(currentMode + 3);
  });
});

intensityInput.addEventListener("input", () => {
  const flux = Number(intensityInput.value);
  wasm.set_intensity(flux / 100);
  fluxNode.textContent = `${flux}%`;
});

shuffleButton.addEventListener("click", () => bumpSeed(31));

requestAnimationFrame(frame);

async function loadWasm(): Promise<StarforgeExports> {
  const wasmUrl = `${import.meta.env.BASE_URL}starforge_hyperdrive.wasm`;
  const response = await fetch(wasmUrl);

  if (!response.ok) {
    throw new Error(`Unable to load ${wasmUrl}`);
  }

  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as StarforgeExports;
}

function frame(now: number) {
  if (now - lastRender < targetFrameMs) {
    requestAnimationFrame(frame);
    return;
  }

  const delta = now - lastRender;
  lastRender = now;
  fpsAverage = fpsAverage * 0.92 + (1000 / Math.max(delta, 1)) * 0.08;

  wasm.render(now);

  if (framebuffer.buffer !== wasm.memory.buffer) {
    framebuffer = new Uint8ClampedArray(wasm.memory.buffer, wasm.framebuffer_ptr(), bufferSize);
    imageData = new ImageData(framebuffer, width, height);
  }

  renderContext.putImageData(imageData, 0, 0);

  if (Math.round(now / 250) % 2 === 0) {
    fpsNode.textContent = String(Math.round(fpsAverage));
  }

  requestAnimationFrame(frame);
}

function sendPointer(event: PointerEvent) {
  const rect = starfieldCanvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2 * (width / height);
  const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
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

function bumpSeed(amount: number) {
  seed = (seed + amount * 997 + currentMode * 101) % 100_000;
  wasm.reseed(seed);
}
