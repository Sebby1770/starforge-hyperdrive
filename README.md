# Starforge Hyperdrive

Starforge Hyperdrive is a shareable generative-light instrument powered by a Rust pixel engine compiled to WebAssembly and a dependency-light TypeScript control surface.

Move across the canvas to bend the field, press to deepen its gravity, tune the system, pause on a composition, and export it as a high-resolution PNG. Every mode, intensity, and seed has a canonical URL, so a generated system can be reopened or shared without a backend.

## Quick start

Requirements:

- Node.js 22.12.0 or newer (Node.js 20.19+ is also supported)
- Stable Rust with the `wasm32-unknown-unknown` target

```bash
rustup target add wasm32-unknown-unknown
cd web
npm ci
npm run dev
```

Open the printed local URL. The build helper creates `web/public` automatically on a clean clone, compiles the locked Rust dependencies, and copies the generated WASM engine into place.

## Instrument controls

- **Aurora, Solar, Circuit, Tunnel:** switch between four renderer palettes and field equations.
- **Intensity:** tune field exposure from 15% to 135%.
- **System seed:** enter any unsigned 32-bit number for a repeatable system.
- **Randomise:** generate a new seed with the browser cryptography API.
- **Play / Pause:** animate the field or hold the current composition.
- **Copy link:** copy a canonical URL containing the current mode, intensity, and seed.
- **Export PNG:** save the current frame at 1280 × 784 pixels.
- **Fullscreen:** enter or leave the focused instrument view.
- **Pointer:** move to steer the gravitational centre; press to increase its pull.

Keyboard shortcuts work whenever focus is not on a button, link, form field, or other interactive element, so native `Space` activation and control behaviour are preserved:

| Key | Action |
| --- | --- |
| `1`–`4` | Select a field mode |
| `Space` | Play or pause |
| `R` | Randomise the seed |
| `C` | Copy the share link |
| `E` | Export a PNG |
| `F` | Toggle fullscreen |

The UI uses native controls, visible focus states, live status announcements, pressed-state semantics, and descriptive canvas text. If the operating system requests reduced motion, Starforge opens on a paused frame and waits for explicit playback.

## Shareable URL state

Instrument state is validated and encoded as query parameters:

```text
?mode=circuit&intensity=94&seed=1770
```

- `mode` must be `aurora`, `solar`, `circuit`, or `tunnel`.
- `intensity` is rounded and clamped to `15`–`135`.
- `seed` is rounded and clamped to the unsigned 32-bit range.
- Missing or invalid values fall back to documented defaults.

The browser address is updated in place as controls change. No composition data leaves the browser.

## Build and verification

Run the complete web and WASM verification:

```bash
cd web
npm test
```

This command performs a clean production build, TypeScript type-check, Rust release build for `wasm32-unknown-unknown`, and a Node-based WASM contract test. The verifier checks:

- every public WASM export and framebuffer memory bounds;
- the fixed 320 × 196 RGBA contract;
- deterministic output for identical inputs;
- opaque, nonblank, non-flat frame output;
- material visual changes across modes and seeds;
- distinct output for adjacent seeds at the top of the unsigned 32-bit range;
- renderer mode wrapping and intensity clamping.

The browser-free keyboard contract check also verifies that global shortcuts yield to native interactive-element activation.

Run the native Rust checks independently:

```bash
cargo fmt --check
cargo check --locked
cargo test --locked
cargo check --locked --release --target wasm32-unknown-unknown
```

The native suite covers exported dimensions, state normalisation, deterministic rendering, opacity, visual differentiation, palette bounds, and tone mapping. GitHub Actions runs these checks, dependency auditing, and the complete web build on every pull request and push to `main`.

Audit the locked web dependency tree:

```bash
cd web
npm audit --audit-level=high
```

## Production build

```bash
cd web
npm run build
```

The static application is emitted to `web/dist`. It can be hosted on any static file service; Vite uses relative asset paths so project subpaths work without configuration.

## Architecture

```text
src/lib.rs                 no_std WASM renderer, stable C ABI, native tests
scripts/build-wasm.sh      locked clean-clone Rust-to-WASM build
scripts/verify-wasm.mjs    browser-free ABI and framebuffer verifier
web/index.html             semantic instrument structure
web/src/keyboard.ts        tested interactive-target shortcut guard
web/src/main.ts            playback, URL state, export, input and accessibility runtime
web/src/styles.css         responsive cockpit presentation
.github/workflows/ci.yml   Rust, Node, audit and production-build checks
```

The WebAssembly boundary remains intentionally small: memory, dimensions, framebuffer pointer, render, pointer input, mode, intensity, and seed. Rendering uses a fixed internal RGBA buffer with no allocator or network access.

## Troubleshooting

- **Rust target missing:** run `rustup target add wasm32-unknown-unknown`.
- **WASM fails to load:** use `npm run dev` or `npm run preview`; browsers do not reliably fetch WASM when `index.html` is opened directly from disk.
- **Clipboard blocked:** the address bar still contains the canonical share URL.
- **Fullscreen blocked:** browser policy may require the button to be clicked directly instead of using a keyboard shortcut.
