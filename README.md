# Starforge Hyperdrive

An interactive Rust + WebAssembly visual playground wrapped in a TypeScript/Vite cockpit. Move across the canvas to bend the starfield, press to pull the scene into a denser gravity well, and jump between four generated palettes.

## Stack

- Rust renders every pixel into a WebAssembly framebuffer.
- TypeScript streams the framebuffer into a canvas and manages controls.
- Vite handles the local dev server and production build.
- CSS builds the full-screen cockpit UI.

## Run It

```bash
cd web
npm install
npm run dev
```

Open the printed local URL and play with the canvas.

## Build

```bash
cd web
npm run build
```

The build script compiles the Rust library for `wasm32-unknown-unknown`, copies the `.wasm` into `web/public`, type-checks the frontend, and emits the static site into `web/dist`.

## Verify

```bash
cd web
npm test
```

This runs the full production build and checks that the Rust WASM engine paints a nonblank framebuffer.

## Project Shape

```text
src/lib.rs              Rust pixel engine
scripts/build-wasm.sh   Rust-to-WASM build helper
web/src/main.ts         Browser runtime and controls
web/src/styles.css      Full-screen cockpit styling
```

## Controls

- `Aurora`, `Solar`, `Circuit`, `Tunnel`: switch generated visual modes.
- `Intensity`: change the field exposure and energy.
- `Shuffle`: reseed the generated star system.
- Pointer movement: steer the gravitational center.
