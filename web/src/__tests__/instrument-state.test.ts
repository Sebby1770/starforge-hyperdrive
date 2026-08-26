import { describe, expect, it } from "vitest";

import {
  DEFAULT_STATE,
  MAX_INTENSITY,
  MAX_SEED,
  MIN_INTENSITY,
  MODES,
  boundedInteger,
  instrumentSearchParams,
  normaliseState,
  parseInstrumentState
} from "../instrument-state";

describe("boundedInteger", () => {
  it("falls back for absent, blank, and non-numeric input", () => {
    expect(boundedInteger(null, 0, 10, 7)).toBe(7);
    expect(boundedInteger("", 0, 10, 7)).toBe(7);
    expect(boundedInteger("   ", 0, 10, 7)).toBe(7);
    expect(boundedInteger("not-a-number", 0, 10, 7)).toBe(7);
    expect(boundedInteger("NaN", 0, 10, 7)).toBe(7);
    expect(boundedInteger("Infinity", 0, 10, 7)).toBe(7);
  });

  it("clamps into range and rounds to an integer", () => {
    expect(boundedInteger("-5", 0, 10, 7)).toBe(0);
    expect(boundedInteger("99", 0, 10, 7)).toBe(10);
    expect(boundedInteger("4.6", 0, 10, 7)).toBe(5);
  });
});

describe("parseInstrumentState", () => {
  it("reads a canonical share link", () => {
    expect(parseInstrumentState("?mode=circuit&intensity=94&seed=1770")).toEqual({
      mode: 2,
      intensity: 94,
      seed: 1770
    });
  });

  it("is case-insensitive on the mode name", () => {
    expect(parseInstrumentState("?mode=TUNNEL").mode).toBe(3);
  });

  it("falls back to defaults for an unknown mode", () => {
    expect(parseInstrumentState("?mode=wormhole").mode).toBe(DEFAULT_STATE.mode);
  });

  it("clamps hostile intensity and seed values", () => {
    const state = parseInstrumentState("?intensity=99999&seed=-1");
    expect(state.intensity).toBe(MAX_INTENSITY);
    expect(state.seed).toBe(0);

    const low = parseInstrumentState("?intensity=0&seed=99999999999");
    expect(low.intensity).toBe(MIN_INTENSITY);
    expect(low.seed).toBe(MAX_SEED);
  });

  it("returns documented defaults for an empty query", () => {
    expect(parseInstrumentState("")).toEqual(DEFAULT_STATE);
  });
});

describe("normaliseState", () => {
  it("rejects out-of-range and fractional modes", () => {
    expect(normaliseState({ ...DEFAULT_STATE, mode: 9 }).mode).toBe(0);
    expect(normaliseState({ ...DEFAULT_STATE, mode: -1 }).mode).toBe(0);
    expect(normaliseState({ ...DEFAULT_STATE, mode: 1.5 }).mode).toBe(0);
  });

  it("is idempotent", () => {
    const once = normaliseState({ mode: 3, intensity: 999, seed: -4 });
    expect(normaliseState(once)).toEqual(once);
  });
});

describe("instrumentSearchParams", () => {
  it("round-trips every mode through parse", () => {
    for (let mode = 0; mode < MODES.length; mode += 1) {
      const state = { mode, intensity: 42, seed: 909 };
      const search = `?${instrumentSearchParams(state).toString()}`;
      expect(parseInstrumentState(search)).toEqual(state);
    }
  });

  it("serialises the clamped value, not the raw one", () => {
    const params = instrumentSearchParams({ mode: 0, intensity: 9999, seed: -1 });
    expect(params.get("intensity")).toBe(String(MAX_INTENSITY));
    expect(params.get("seed")).toBe("0");
  });
});
