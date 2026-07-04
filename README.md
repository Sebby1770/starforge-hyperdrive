# Starforge Hyperdrive

An interactive Rust + WebAssembly visual playground wrapped in a TypeScript/Vite cockpit. Move across the canvas to bend the starfield, press to pull the scene into a denser gravity well, and jump between four generated palettes.

## Stack

- Rust renders every pixel into a WebAssembly framebuffer.
- TypeScript uploads the framebuffer via WebGL (Canvas2D fallback) and manages controls.
- A real `flux()` meter reports mean frame energy from the WASM engine.
- Vite handles the local dev server and production build.
- CSS builds the full-screen cockpit UI.

## Prerequisites

- Node.js 20+
- Rust (stable) with the WASM target:

```bash
rustup target add wasm32-unknown-unknown
```

The `.wasm` binary is built locally and is not committed to git. Run `npm run build:wasm` (or `npm run dev`) after cloning.

Optional: install [Binaryen](https://github.com/WebAssembly/binaryen) for smaller, faster WASM via `wasm-opt`.

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

## Deploy

```bash
cd web
npm run build
```

Deploy the contents of `web/dist` to any static host (GitHub Pages, Netlify, Cloudflare Pages). `vite.config.ts` uses `base: "./"` so relative asset paths work from subdirectories.

## Verify

```bash
cd web
npm test
```

This runs the full production build and checks that the Rust WASM engine paints a nonblank framebuffer across all four visual modes.

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
- `Fullscreen`: hide browser chrome for demos.
- Pointer movement: steer the gravitational center.
- Pointer press: increase gravitational pull.

### Keyboard

- `1`–`4`: visual modes
- `Space`: shuffle seed
- `+` / `-`: intensity
- `F`: fullscreen

Shareable URLs preserve `mode`, `intensity`, and `seed` query parameters.