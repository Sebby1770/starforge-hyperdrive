# Starforge Hyperdrive

**Live instrument:** [sebby1770.github.io/starforge-hyperdrive](https://sebby1770.github.io/starforge-hyperdrive/)

Starforge Hyperdrive is a shareable generative-light instrument powered by a Rust pixel engine compiled to WebAssembly and a dependency-light TypeScript control surface.

Move across the canvas to bend the field, press to deepen its gravity, tune the system, pause on a composition, and export it as a natively rendered 1280 x 784 PNG. Every mode, intensity, seed, and speed has a canonical URL, so a generated system can be reopened or shared without a backend.

Twelve field modes, a resolution ladder that adapts to the machine it is running
on, and a shipped engine whose only dependency is `libm`. The web bundle has no
runtime dependencies at all.

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

- **Aurora, Solar, Circuit, Tunnel, Nebula, Lattice, Prism, Vortex, Tide, Pulsar, Forge, Eclipse:** twelve field equations and palettes.
- **Intensity:** tune field exposure from 15% to 135%.
- **Speed:** scale how fast the field evolves, from frozen (0%) to 300%.
- **Render quality:** `Auto`, or pin the engine to Draft, Standard, High, or Ultra.
- **Presets:** twelve curated compositions, one click each.
- **Hue:** rotate the palette without changing the field.
- **Drive audio:** optional tone that follows live flux (`M`).
- **System seed:** enter any unsigned 32-bit number for a repeatable system.
- **Randomise:** generate a new seed with the browser cryptography API.
- **Play / Pause:** animate the field or hold the current composition.
- **Copy link:** copy a canonical URL containing the current mode, intensity, and seed.
- **Export PNG:** re-render the current composition natively at 1280 × 784 and save it.
- **Fullscreen:** enter or leave the focused instrument view.
- **Hide UI:** collapse the chrome for a clean capture; the toggle stays visible.
- **Pointer:** move to steer the gravitational centre; press to increase its pull.

Keyboard shortcuts work whenever focus is not on a button, link, form field, or other interactive element, so native `Space` activation and control behaviour are preserved:

| Key | Action |
| --- | --- |
| `1`–`9`, `0`, `-`, `=` | Select a field mode |
| `M` | Toggle drive audio |
| `Space` | Play or pause |
| `R` | Randomise the seed |
| `C` | Copy the share link |
| `E` | Export a PNG |
| `F` | Toggle fullscreen |
| `H` | Hide or show the interface |

The UI uses native controls, visible focus states, live status announcements, pressed-state semantics, and descriptive canvas text. If the operating system requests reduced motion, Starforge opens on a paused frame and waits for explicit playback.

## Live telemetry

The meter cluster reports what the engine and renderer are actually doing:

| Meter | Source |
| --- | --- |
| FPS | Smoothed frame rate of the animation loop |
| Flux | `flux()` — mean per-pixel exposure of the frame just rendered, as a percentage of the engine's exposure clamp |
| Frame | GPU upload + draw time for the last presented frame |
| Backend | `WebGL2`, or `Canvas2D` where WebGL2 is unavailable |
| Render | Live engine resolution |
| Drive | Playback state |

Flux is read back from the Rust engine rather than derived in JavaScript, so it
responds to mode, seed, and pointer gravity as well as the intensity control.

Rendering prefers a WebGL2 texture blit and transparently falls back to
`putImageData` on a 2D context; the Backend meter shows which path is live.

The Frame meter reports engine time plus GPU upload and draw, so the number the
adaptive controller acts on is the same one you can read off the panel.

## Resolution

The engine renders into a runtime-selectable framebuffer. Every tier is a whole
multiple of a 160 x 98 tile, so changing quality re-renders the same composition
at more samples instead of reframing it.

| Tier | Resolution | Role |
| --- | --- | --- |
| Draft | 320 × 196 | Adaptive floor |
| Standard | 480 × 294 | |
| High | 640 × 392 | Held frame while quality is automatic |
| Ultra | 960 × 588 | |
| Export | 1280 × 784 | PNG export only |

`Auto` opens at the floor and climbs only when the next tier up is *projected*
to fit inside the frame budget, so a machine is never shown a quality drop a
second after load, and the controller settles rather than oscillating between
two neighbouring tiers.

Pausing removes the frame budget entirely, so a held frame is rendered at High
even when playback was running at Draft. That is the state worth screenshotting.

PNG export is a genuine native render, not an upscale: the engine is retargeted
to 1280 × 784, one frame is rendered, and the tier is restored — including if
the export fails. Releases before v0.3.0 saved a bilinear enlargement of the
320 × 196 preview under the same button.

## Shareable URL state

Instrument state is validated and encoded as query parameters:

```text
?mode=circuit&intensity=94&seed=1770&speed=150&quality=high
```

- `mode` must be one of `aurora`, `solar`, `circuit`, `tunnel`, `nebula`,
  `lattice`, `prism`, `vortex`, `tide`, `pulsar`, `forge`, or `eclipse`.
- `hue` is rounded and clamped to `0`–`360`.
- `intensity` is rounded and clamped to `15`–`135`.
- `seed` is rounded and clamped to the unsigned 32-bit range.
- `speed` is rounded and clamped to `0`–`300`.
- `quality` must be `auto`, `draft`, `standard`, `high`, or `ultra`.
- Missing or invalid values fall back to documented defaults.
- `speed` and `quality` are omitted when they sit at their defaults, so links
  minted before those controls existed still round-trip unchanged.

The browser address is updated in place as controls change. No composition data leaves the browser.

## Build and verification

Run the complete web and WASM verification:

```bash
cd web
npm test
```

This command performs a clean production build, TypeScript type-check, Rust release build for `wasm32-unknown-unknown`, and a Node-based WASM contract test. The verifier checks:

- every public WASM export and framebuffer memory bounds;
- the RGBA contract at every rung of the resolution ladder, including that each
  tier renders a complete opaque frame and addresses only memory it owns;
- `set_resolution` clamping outside the supported scale range;
- deterministic output for identical inputs;
- opaque, nonblank, non-flat frame output;
- that all twelve modes render lit frames and that no two of them alias;
- material visual changes across modes and seeds;
- distinct output for adjacent seeds at the top of the unsigned 32-bit range;
- renderer mode wrapping and intensity clamping.

The browser-free keyboard contract check also verifies that global shortcuts yield to native interactive-element activation.

Run the native Rust checks independently:

```bash
cargo fmt --check
cargo check --locked
cargo test --locked   # engine: determinism, clamping, flux telemetry
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
src/fastmath.rs            fast sin/cos/exp approximations, error-bounded vs std
scripts/build-wasm.sh      locked clean-clone Rust-to-WASM build
scripts/verify-wasm.mjs    browser-free ABI and framebuffer verifier
web/index.html             semantic instrument structure
web/src/keyboard.ts        tested interactive-target shortcut guard
web/src/instrument-state.ts pure share-link model (parse, clamp, serialise)
web/src/drive-audio.ts     optional flux-driven tone, muted until enabled
web/src/renderer.ts        WebGL2 renderer with a Canvas2D fallback
web/src/effects.ts         spotlight cards and hide-UI chrome
.github/workflows/pages.yml GitHub Pages build and deploy
web/src/__tests__/         Vitest unit tests
web/src/main.ts            playback, URL state, export, input and accessibility runtime
web/src/styles.css         responsive cockpit presentation
.github/workflows/ci.yml   Rust, Node, audit and production-build checks
```

The WebAssembly boundary remains intentionally small: memory, dimensions,
maximum dimensions, mode count, resolution selection, framebuffer pointer,
render, flux readback, pointer input, mode, intensity, hue, and seed. Rendering
uses a statically sized internal RGBA buffer — allocated for the largest
supported tier and used as a prefix below it — with no allocator, no
dependencies, and no network access.

### Engine performance

The field equation evaluates roughly fifteen transcendental terms per pixel, so
frame cost is what caps resolution. v0.3.0 attacks that directly:

- per-frame and per-octave trigonometry that was being recomputed for every
  pixel is now hoisted out of the loop;
- `sin`, `cos`, and `exp` are replaced by error-bounded approximations
  (`src/fastmath.rs`), each pinned against `std` by a test.

Measured in Node on the shipped `wasm32-unknown-unknown` build:

| Build | ns/pixel | 320 × 196 frame |
| --- | --- | --- |
| v0.2.0 | 328 | 20.6 ms |
| v0.3.0 | 153 | 9.6 ms |

Hand-rolled `floor` and `sqrt` were tried and reverted: `libm` already lowers
both to a single machine instruction, so replacing them was a measured
regression.

## Troubleshooting

- **Rust target missing:** run `rustup target add wasm32-unknown-unknown`.
- **WASM fails to load:** use `npm run dev` or `npm run preview`; browsers do not reliably fetch WASM when `index.html` is opened directly from disk.
- **Clipboard blocked:** the address bar still contains the canonical share URL.
- **Fullscreen blocked:** browser policy may require the button to be clicked directly instead of using a keyboard shortcut.
