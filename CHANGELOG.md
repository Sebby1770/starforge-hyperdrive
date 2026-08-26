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