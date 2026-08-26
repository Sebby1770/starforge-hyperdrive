/**
 * Pure instrument-state model shared by the control surface and its tests.
 *
 * Everything here is deliberately free of DOM and WebAssembly access so the
 * share-link contract can be exercised directly by unit tests: a Starforge URL
 * is the project's only persistence format, so its parsing and clamping rules
 * are the part most worth pinning down.
 */

export const MODES = ["Aurora", "Solar", "Circuit", "Tunnel"] as const;

export type ModeName = (typeof MODES)[number];

export type InstrumentState = {
  mode: number;
  intensity: number;
  seed: number;
};

export const MIN_INTENSITY = 15;
export const MAX_INTENSITY = 135;
export const MAX_SEED = 4_294_967_295;

export const DEFAULT_STATE: InstrumentState = {
  mode: 0,
  intensity: 76,
  seed: 1770
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
    seed: boundedInteger(String(state.seed), 0, MAX_SEED, DEFAULT_STATE.seed)
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
    seed: boundedInteger(params.get("seed"), 0, MAX_SEED, DEFAULT_STATE.seed)
  });
}

/** Serialises state into the canonical share-link query parameters. */
export function instrumentSearchParams(state: InstrumentState): URLSearchParams {
  const normalised = normaliseState(state);
  const params = new URLSearchParams();
  params.set("mode", MODES[normalised.mode].toLowerCase());
  params.set("intensity", String(normalised.intensity));
  params.set("seed", String(normalised.seed));
  return params;
}
