# Changelog

All notable changes to **starforge-hyperdrive** are documented here.

## [Unreleased]

### Fixed
- Completed the unfinished merge between the tested-engine and WebGL lineages.
  The half-resolved tree had kept the CPU-only control surface while leaving
  `web/src/renderer.ts` and `web/src/effects.ts` orphaned, so three features the
  0.2.0 notes already claimed were silently absent from the running app:
  - **The flux meter was fake.** It echoed the intensity slider because the Rust
    `flux()` export had been dropped in the merge. The engine now accumulates
    mean per-pixel exposure again and the meter reads it back per frame.
  - **The WebGL renderer was dead code.** Rendering went straight to a 2D
    context; it now runs through `createRenderer()` (WebGL2, Canvas2D fallback)
    and reports the live backend and frame time.
  - **Hide-UI and spotlight cards were dead code.** `initUiChrome()` and
    `initSpotlightCards()` were never called and their markup hooks were absent.
- Telemetry now refreshes on every control change, not only inside the animation
  loop, so meters stay correct while playback is paused.
- Canvas2D fallback rebuilds its `ImageData` when the engine reports different
  frame dimensions instead of throwing on a length mismatch.
- Moved the Hide-UI toggle into the header; as a child of the control dock it
  hid itself, stranding pointer users in a chrome-less view.

### Added
- `web/src/instrument-state.ts`: the share-link contract (parse, clamp,
  serialise) extracted as a pure module.
- Vitest suite with 16 tests covering share-link parsing/clamping/round-trips
  and the keyboard shortcut guard.
- Three Rust tests pinning flux to the exposure clamp and to intensity.
- WASM ABI verifier now proves `flux()` is a real readback that tracks
  intensity rather than a constant.

### Changed
- TypeScript raised to `noUnusedLocals`, `noUnusedParameters`,
  `exactOptionalPropertyTypes`, and `noImplicitOverride`.
- CI runs `cargo clippy -D warnings`, a type-check, and the Vitest suite.


## 0.3.0 - 2026-09-07

### Added

- Runtime-selectable render resolution. The engine renders into a statically
  sized framebuffer at any whole multiple of a 160 x 98 tile from 320 x 196 up
  to 1280 x 784, exposed as `set_resolution`, `max_width`, and `max_height`.
- Adaptive quality. With `Auto` selected, the control surface measures engine
  frame cost and climbs the tier ladder only when the next rung is projected to
  fit the budget, so it settles instead of oscillating and never opens on a
  quality it has to drop a second later.
- Held frames render at a higher tier. Pausing removes the frame budget, so a
  paused composition is re-rendered at 640 x 392 even when playback was running
  at 320 x 196.
- Four new field modes and palettes: Nebula, Lattice, Prism, and Vortex, taking
  the instrument to eight. `mode_count` is exported so the control surface fails
  loudly rather than silently disagreeing with the engine.
- A speed control (0-300%) and a render-quality selector, both carried in the
  share link as `speed` and `quality`.
- Eight curated presets.
- A live demo, deployed to GitHub Pages on every push to `main`.
- `src/fastmath.rs`: error-bounded `sin`, `cos`, and `exp` approximations, each
  pinned against `std` by a test.

### Changed

- **PNG export is now a native render rather than an upscale.** Earlier releases
  drew the 320 x 196 preview canvas into a 1280 x 784 buffer with bilinear
  smoothing and called the result high-resolution. The engine is now retargeted
  to 1280 x 784 and renders the composition again, so the saved file carries
  detail the preview never had. The preview tier is restored afterwards, and
  also on failure.
- The engine is roughly 2.1x faster: 328 ns/pixel to 153 ns/pixel on the shipped
  wasm build, or 20.6 ms to 9.6 ms for a 320 x 196 frame. Per-frame and
  per-octave trigonometry that was being recomputed for every pixel is hoisted
  out of the loop, and the transcendental calls now go through `fastmath`.
- The Frame meter reports engine time as well as GPU upload and draw, so it
  matches the number the adaptive controller acts on.
- Keyboard mode selection covers `1`-`8`.

### Fixed

- The `H` (hide UI) shortcut bypassed the interactive-target guard that every
  other shortcut respects: it checked only for a text input, so it fired while a
  button or slider held focus, contradicting the documented shortcut contract
  and stealing the key from the focused control. It now shares the same guard,
  with a regression test.
- The Rust test suite raced itself. Several tests drive the exported ABI, which
  reads and writes process-wide statics, while the default runner executes them
  in parallel. Those tests now serialise on a shared lock.

### Removed

- Nothing. Share links minted before this release still open unchanged; `speed`
  and `quality` fall back to their defaults.
## [0.2.0] - 2026-07-04

### Added
- WebGL texture renderer with Canvas2D fallback (`web/src/renderer.ts`)
- Real `flux()` WASM export and cockpit flux meter
- Render timing meter (WASM + GPU upload + draw)
- React Bits–inspired UI polish:
  - Soft aurora background layer
  - Spotlight card hover glow
  - Animated gradient title text
  - Rotating glow borders on controls
- Hide UI mode (`H` key / button) for clean demos
- Favicon and theme color meta tags
- `CHANGELOG.md`, expanded README, GitHub Actions CI

### Changed
- Loading and error overlays use glass spotlight cards
- Pointer capture lifecycle fixes and keyboard shortcuts
- Shareable URL state for mode, intensity, and seed
- `prefers-reduced-motion` lowers animation frame rate

### Fixed
- WASM build script creates `web/public/` automatically
- Stuck pointer-down state on gesture cancel

## [0.1.0] - 2026-07-04

### Added
- Initial Rust + WASM pixel engine with four visual modes
- TypeScript/Vite cockpit shell
- Production build and WASM verification script