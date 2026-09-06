import { describe, expect, it } from "vitest";
import {
  ADAPTIVE_SCALES,
  DEFAULT_STATE,
  EXPORT_SCALE,
  MAX_INTENSITY,
  MAX_SEED,
  MAX_SPEED,
  MIN_INTENSITY,
  MODES,
  PRESETS,
  QUALITY_TIERS,
  TIER_SCALES,
  TILE_HEIGHT,
  TILE_WIDTH,
  boundedInteger,
  instrumentSearchParams,
  nextAdaptiveScale,
  normaliseQuality,
  normaliseState,
  parseInstrumentState,
  resolutionForScale
} from "../instrument-state";

describe("boundedInteger", () => {
  it("falls back for empty, blank, and non-numeric input", () => {
    expect(boundedInteger(null, 0, 10, 4)).toBe(4);
    expect(boundedInteger("", 0, 10, 4)).toBe(4);
    expect(boundedInteger("   ", 0, 10, 4)).toBe(4);
    expect(boundedInteger("banana", 0, 10, 4)).toBe(4);
    expect(boundedInteger("Infinity", 0, 10, 4)).toBe(4);
    expect(boundedInteger("NaN", 0, 10, 4)).toBe(4);
  });

  it("rounds and clamps into range", () => {
    expect(boundedInteger("7.6", 0, 10, 4)).toBe(8);
    expect(boundedInteger("-40", 0, 10, 4)).toBe(0);
    expect(boundedInteger("400", 0, 10, 4)).toBe(10);
  });
});

describe("parseInstrumentState", () => {
  it("reads a complete query string", () => {
    const state = parseInstrumentState("?mode=circuit&intensity=94&seed=1770&speed=150&quality=high");
    expect(state).toEqual({ mode: 2, intensity: 94, seed: 1770, speed: 150, quality: "high" });
  });

  it("resolves every documented mode name case-insensitively", () => {
    MODES.forEach((mode, index) => {
      expect(parseInstrumentState(`?mode=${mode.toUpperCase()}`).mode).toBe(index);
    });
  });

  it("falls back to defaults for unknown or hostile values", () => {
    const state = parseInstrumentState("?mode=chartreuse&intensity=NaN&seed=&speed=x&quality=ultra9");
    expect(state).toEqual(DEFAULT_STATE);
  });

  it("clamps out-of-range values rather than rejecting the link", () => {
    const state = parseInstrumentState("?intensity=9999&seed=-5&speed=99999");
    expect(state.intensity).toBe(MAX_INTENSITY);
    expect(state.seed).toBe(0);
    expect(state.speed).toBe(MAX_SPEED);
  });

  it("still reads links minted before speed and quality existed", () => {
    const state = parseInstrumentState("?mode=solar&intensity=80&seed=42");
    expect(state.mode).toBe(1);
    expect(state.speed).toBe(DEFAULT_STATE.speed);
    expect(state.quality).toBe(DEFAULT_STATE.quality);
  });
});

describe("normaliseState", () => {
  it("repairs an out-of-range mode", () => {
    expect(normaliseState({ ...DEFAULT_STATE, mode: 99 }).mode).toBe(DEFAULT_STATE.mode);
    expect(normaliseState({ ...DEFAULT_STATE, mode: -1 }).mode).toBe(DEFAULT_STATE.mode);
    expect(normaliseState({ ...DEFAULT_STATE, mode: 1.5 }).mode).toBe(DEFAULT_STATE.mode);
  });

  it("accepts every mode the interface offers", () => {
    MODES.forEach((_, index) => {
      expect(normaliseState({ ...DEFAULT_STATE, mode: index }).mode).toBe(index);
    });
  });

  it("clamps intensity, seed, and speed", () => {
    const state = normaliseState({
      mode: 0,
      intensity: -100,
      seed: MAX_SEED + 5000,
      speed: -20,
      quality: "auto"
    });
    expect(state.intensity).toBe(MIN_INTENSITY);
    expect(state.seed).toBe(MAX_SEED);
    expect(state.speed).toBe(0);
  });
});

describe("normaliseQuality", () => {
  it("accepts every declared tier and rejects anything else", () => {
    QUALITY_TIERS.forEach((tier) => expect(normaliseQuality(tier)).toBe(tier));
    expect(normaliseQuality("HIGH")).toBe("high");
    expect(normaliseQuality("cinematic")).toBe(DEFAULT_STATE.quality);
    expect(normaliseQuality(undefined)).toBe(DEFAULT_STATE.quality);
    expect(normaliseQuality(null)).toBe(DEFAULT_STATE.quality);
  });
});

describe("instrumentSearchParams", () => {
  it("round-trips through the parser", () => {
    const state = { mode: 6, intensity: 111, seed: 9090, speed: 175, quality: "ultra" as const };
    expect(parseInstrumentState(`?${instrumentSearchParams(state).toString()}`)).toEqual(state);
  });

  it("round-trips every preset", () => {
    PRESETS.forEach((preset) => {
      const state = normaliseState({ ...DEFAULT_STATE, ...preset.state });
      expect(parseInstrumentState(`?${instrumentSearchParams(state).toString()}`)).toEqual(state);
    });
  });

  it("omits defaulted speed and quality so short links stay short", () => {
    const params = instrumentSearchParams(DEFAULT_STATE);
    expect(params.has("speed")).toBe(false);
    expect(params.has("quality")).toBe(false);
    expect(params.get("mode")).toBe("aurora");
  });
});

describe("presets", () => {
  it("declares a unique, in-range composition for each entry", () => {
    const ids = new Set(PRESETS.map((preset) => preset.id));
    expect(ids.size).toBe(PRESETS.length);

    PRESETS.forEach((preset) => {
      expect(normaliseState({ ...DEFAULT_STATE, ...preset.state })).toEqual({
        ...preset.state,
        quality: DEFAULT_STATE.quality
      });
    });
  });

  it("leaves the viewer's quality choice alone", () => {
    PRESETS.forEach((preset) => {
      expect(preset.state).not.toHaveProperty("quality");
    });
  });
});

describe("resolution ladder", () => {
  it("keeps one aspect ratio across every tier and the export size", () => {
    const base = TILE_WIDTH / TILE_HEIGHT;
    const scales = [...ADAPTIVE_SCALES, EXPORT_SCALE];

    scales.forEach((scale) => {
      const { width, height } = resolutionForScale(scale);
      expect(width / height).toBeCloseTo(base, 10);
    });
  });

  it("exports above every tier the animation loop can select", () => {
    expect(EXPORT_SCALE).toBeGreaterThan(Math.max(...ADAPTIVE_SCALES));
    expect(resolutionForScale(EXPORT_SCALE)).toEqual({ width: 1280, height: 784 });
  });

  it("maps every named tier onto an adaptive scale", () => {
    Object.values(TIER_SCALES).forEach((scale) => {
      expect(ADAPTIVE_SCALES).toContain(scale);
    });
  });
});

describe("nextAdaptiveScale", () => {
  const budget = 16;

  it("drops a tier when the engine overruns its budget", () => {
    expect(nextAdaptiveScale(4, 30, budget)).toBe(3);
    expect(nextAdaptiveScale(3, 21, budget)).toBe(2);
  });

  it("never drops below the floor", () => {
    expect(nextAdaptiveScale(2, 500, budget)).toBe(2);
  });

  it("never climbs above the ceiling", () => {
    expect(nextAdaptiveScale(6, 0.5, budget)).toBe(6);
  });

  it("climbs only when the higher tier is projected to fit", () => {
    // Scale 2 -> 3 multiplies pixel count by 2.25, so 4ms projects to 9ms and
    // fits, while 6ms projects to 13.5ms and would immediately be demoted.
    expect(nextAdaptiveScale(2, 4, budget)).toBe(3);
    expect(nextAdaptiveScale(2, 6, budget)).toBe(2);
  });

  it("settles instead of oscillating between neighbouring tiers", () => {
    // A cost that sits inside the budget at its own tier but would overrun the
    // next one up must be a fixed point of the controller.
    let scale = 3;
    for (let i = 0; i < 20; i += 1) {
      scale = nextAdaptiveScale(scale, 12, budget);
    }
    expect(scale).toBe(3);
  });

  it("recovers from an unknown scale", () => {
    expect(nextAdaptiveScale(99, 8, budget)).toBe(ADAPTIVE_SCALES[0]);
  });
});
