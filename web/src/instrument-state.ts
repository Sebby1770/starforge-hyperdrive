/**
 * Pure instrument-state model shared by the control surface and its tests.
 *
 * Everything here is deliberately free of DOM and WebAssembly access so the
 * share-link contract can be exercised directly by unit tests: a Starforge URL
 * is the project's only persistence format, so its parsing and clamping rules
 * are the part most worth pinning down.
 */

export const MODES = [
  "Aurora",
  "Solar",
  "Circuit",
  "Tunnel",
  "Nebula",
  "Lattice",
  "Prism",
  "Vortex",
  "Tide",
  "Pulsar",
  "Forge",
  "Eclipse"
] as const;

export type ModeName = (typeof MODES)[number];

/**
 * Render-quality ladder.
 *
 * `scale` is the multiplier the engine applies to its 160 x 98 tile, so every
 * tier renders the same composition at more samples rather than reframing it.
 * `auto` carries no scale of its own: the runtime picks a tier from measured
 * frame time and re-evaluates as conditions change.
 */
export const QUALITY_TIERS = ["auto", "draft", "standard", "high", "ultra"] as const;

export type QualityTier = (typeof QUALITY_TIERS)[number];

export const TIER_SCALES: Record<Exclude<QualityTier, "auto">, number> = {
  draft: 2,
  standard: 3,
  high: 4,
  ultra: 6
};

/** Scales the adaptive controller is allowed to choose between. */
export const ADAPTIVE_SCALES = [2, 3, 4, 6] as const;

/** Resolution used for PNG export, rendered natively rather than upscaled. */
export const EXPORT_SCALE = 8;

export const TILE_WIDTH = 160;
export const TILE_HEIGHT = 98;

export type InstrumentState = {
  mode: number;
  intensity: number;
  seed: number;
  speed: number;
  hue: number;
  quality: QualityTier;
};

export const MIN_INTENSITY = 15;
export const MAX_INTENSITY = 135;
export const MAX_SEED = 4_294_967_295;
export const MIN_SPEED = 0;
export const MAX_SPEED = 300;
export const MIN_HUE = 0;
export const MAX_HUE = 360;

export const DEFAULT_STATE: InstrumentState = {
  mode: 0,
  intensity: 76,
  seed: 1770,
  speed: 100,
  hue: 0,
  quality: "auto"
};

/**
 * Clamps a possibly-hostile string to an integer inside [min, max].
 *
 * Returns `fallback` for anything non-finite so a malformed share link opens on
 * the documented defaults instead of poisoning the engine with NaN.
 */
export function boundedInteger(
  value: string | null,
  min: number,
  max: number,
  fallback: number
): number {
  if (value === null || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** Coerces an arbitrary value to a known quality tier. */
export function normaliseQuality(value: unknown): QualityTier {
  const candidate = String(value ?? "").toLowerCase();
  return (QUALITY_TIERS as readonly string[]).includes(candidate)
    ? (candidate as QualityTier)
    : DEFAULT_STATE.quality;
}

/** Coerces any candidate state into the engine's accepted ranges. */
export function normaliseState(state: InstrumentState): InstrumentState {
  return {
    mode:
      Number.isInteger(state.mode) && state.mode >= 0 && state.mode < MODES.length
        ? state.mode
        : DEFAULT_STATE.mode,
    intensity: boundedInteger(
      String(state.intensity),
      MIN_INTENSITY,
      MAX_INTENSITY,
      DEFAULT_STATE.intensity
    ),
    seed: boundedInteger(String(state.seed), 0, MAX_SEED, DEFAULT_STATE.seed),
    speed: boundedInteger(String(state.speed), MIN_SPEED, MAX_SPEED, DEFAULT_STATE.speed),
    hue: boundedInteger(String(state.hue), MIN_HUE, MAX_HUE, DEFAULT_STATE.hue),
    quality: normaliseQuality(state.quality)
  };
}

/** Parses a query string (`?mode=…&intensity=…&seed=…`) into a valid state. */
export function parseInstrumentState(search: string): InstrumentState {
  const params = new URLSearchParams(search);
  const requestedMode = params.get("mode")?.toLowerCase();
  const modeIndex = MODES.findIndex((mode) => mode.toLowerCase() === requestedMode);

  return normaliseState({
    mode: modeIndex === -1 ? DEFAULT_STATE.mode : modeIndex,
    intensity: boundedInteger(
      params.get("intensity"),
      MIN_INTENSITY,
      MAX_INTENSITY,
      DEFAULT_STATE.intensity
    ),
    seed: boundedInteger(params.get("seed"), 0, MAX_SEED, DEFAULT_STATE.seed),
    speed: boundedInteger(params.get("speed"), MIN_SPEED, MAX_SPEED, DEFAULT_STATE.speed),
    hue: boundedInteger(params.get("hue"), MIN_HUE, MAX_HUE, DEFAULT_STATE.hue),
    quality: normaliseQuality(params.get("quality"))
  });
}

/**
 * Serialises state into the canonical share-link query parameters.
 *
 * Parameters left at their defaults are omitted, so links minted before `speed`
 * and `quality` existed keep round-tripping to the same short URL.
 */
export function instrumentSearchParams(state: InstrumentState): URLSearchParams {
  const normalised = normaliseState(state);
  const params = new URLSearchParams();
  params.set("mode", MODES[normalised.mode].toLowerCase());
  params.set("intensity", String(normalised.intensity));
  params.set("seed", String(normalised.seed));

  if (normalised.speed !== DEFAULT_STATE.speed) {
    params.set("speed", String(normalised.speed));
  }

  if (normalised.quality !== DEFAULT_STATE.quality) {
    params.set("quality", normalised.quality);
  }

  if (normalised.hue !== DEFAULT_STATE.hue) {
    params.set("hue", String(normalised.hue));
  }

  return params;
}

/**
 * Curated starting points.
 *
 * Each preset fixes the parameters that define a composition and deliberately
 * leaves `quality` alone, so loading one never overrides the viewer's own
 * performance choice.
 */
export const PRESETS: ReadonlyArray<{
  id: string;
  name: string;
  state: Pick<InstrumentState, "mode" | "intensity" | "seed" | "speed" | "hue">;
}> = [
  { id: "deep-field", name: "Deep Field", state: { mode: 0, intensity: 62, seed: 20482, speed: 45, hue: 0 } },
  { id: "coronal", name: "Coronal", state: { mode: 1, intensity: 118, seed: 907331, speed: 130, hue: 12 } },
  { id: "mainboard", name: "Mainboard", state: { mode: 2, intensity: 88, seed: 5150, speed: 70, hue: 0 } },
  { id: "descent", name: "Descent", state: { mode: 3, intensity: 104, seed: 771020, speed: 165, hue: 0 } },
  { id: "ion-drift", name: "Ion Drift", state: { mode: 4, intensity: 71, seed: 3312887, speed: 35, hue: 40 } },
  { id: "weave", name: "Weave", state: { mode: 5, intensity: 96, seed: 44117, speed: 85, hue: 0 } },
  { id: "refraction", name: "Refraction", state: { mode: 6, intensity: 127, seed: 1618033, speed: 110, hue: 0 } },
  { id: "maelstrom", name: "Maelstrom", state: { mode: 7, intensity: 133, seed: 8675309, speed: 200, hue: 18 } },
  { id: "flood", name: "Flood", state: { mode: 8, intensity: 92, seed: 424242, speed: 80, hue: 0 } },
  { id: "beacon", name: "Beacon", state: { mode: 9, intensity: 110, seed: 1201, speed: 150, hue: 200 } },
  { id: "crucible", name: "Crucible", state: { mode: 10, intensity: 124, seed: 9009, speed: 90, hue: 0 } },
  { id: "occultation", name: "Occultation", state: { mode: 11, intensity: 108, seed: 314159, speed: 40, hue: 30 } }
];

/** Pixel dimensions the engine renders at for a given scale. */
export function resolutionForScale(scale: number) {
  return { width: TILE_WIDTH * scale, height: TILE_HEIGHT * scale };
}

/**
 * Picks the next adaptive scale from the most recent engine frame cost.
 *
 * The engine's cost is very close to linear in pixel count, so the projected
 * cost of a neighbouring tier is the measured cost rescaled by its pixel ratio.
 * Deciding on the projection rather than on the current tier's own budget keeps
 * the controller from oscillating between two tiers that straddle the target.
 */
export function nextAdaptiveScale(
  currentScale: number,
  frameMs: number,
  budgetMs: number
): number {
  const index = ADAPTIVE_SCALES.indexOf(currentScale as (typeof ADAPTIVE_SCALES)[number]);

  if (index === -1) {
    return ADAPTIVE_SCALES[0];
  }

  const pixelsFor = (scale: number) => scale * scale;

  if (frameMs > budgetMs && index > 0) {
    return ADAPTIVE_SCALES[index - 1];
  }

  if (index < ADAPTIVE_SCALES.length - 1) {
    const next = ADAPTIVE_SCALES[index + 1];
    const projected = (frameMs * pixelsFor(next)) / pixelsFor(currentScale);

    // Only climb when the higher tier is projected to land clearly inside the
    // budget, so a tier that would immediately be demoted is never selected.
    if (projected < budgetMs * 0.8) {
      return next;
    }
  }

  return currentScale;
}
