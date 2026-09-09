/**
 * Optional drive tone, derived from live flux.
 *
 * Starts silent. The first user gesture that unmutes creates the AudioContext
 * so browsers that block autoplay are not surprised. Reduced-motion viewers
 * keep it off unless they press the button.
 */

export type DriveAudio = {
  muted: boolean;
  setMuted(next: boolean): void;
  setFlux(flux: number, intensity: number): void;
  dispose(): void;
};

export function createDriveAudio(startMuted = true): DriveAudio {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let filter: BiquadFilterNode | null = null;
  let oscA: OscillatorNode | null = null;
  let oscB: OscillatorNode | null = null;
  let muted = startMuted;

  function ensureGraph() {
    if (ctx) {
      return;
    }

    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0;
    filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    oscA = ctx.createOscillator();
    oscB = ctx.createOscillator();
    oscA.type = "sine";
    oscB.type = "triangle";
    oscA.frequency.value = 55;
    oscB.frequency.value = 82.4;
    oscA.connect(filter);
    oscB.connect(filter);
    filter.connect(master);
    master.connect(ctx.destination);
    oscA.start();
    oscB.start();
  }

  return {
    get muted() {
      return muted;
    },
    setMuted(next: boolean) {
      muted = next;
      if (!muted) {
        ensureGraph();
        void ctx?.resume();
      }
      if (master && ctx) {
        master.gain.setTargetAtTime(muted ? 0 : 0.04, ctx.currentTime, 0.08);
      }
    },
    setFlux(flux: number, intensity: number) {
      if (!ctx || !filter || !oscA || !oscB || !master || muted) {
        return;
      }

      const t = ctx.currentTime;
      const f = Math.max(0, Math.min(1.6, flux)) / 1.6;
      oscA.frequency.setTargetAtTime(42 + f * 90, t, 0.08);
      oscB.frequency.setTargetAtTime(63 + f * 140, t, 0.1);
      filter.frequency.setTargetAtTime(280 + intensity * 900, t, 0.12);
      master.gain.setTargetAtTime(0.018 + f * 0.05, t, 0.12);
    },
    dispose() {
      try {
        oscA?.stop();
        oscB?.stop();
        void ctx?.close();
      } catch {
        /* already closed */
      }
      ctx = null;
    }
  };
}
