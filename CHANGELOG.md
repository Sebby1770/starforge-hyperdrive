# Changelog

All notable changes to **starforge-hyperdrive** are documented here.

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