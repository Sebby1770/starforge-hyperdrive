import { describe, expect, it } from "vitest";
import { createDriveAudio } from "../drive-audio";

describe("createDriveAudio", () => {
  it("starts muted and ignores flux until unmuted", () => {
    const audio = createDriveAudio(true);
    expect(audio.muted).toBe(true);
    expect(() => audio.setFlux(0.9, 1.1)).not.toThrow();
    audio.dispose();
  });

  it("can be constructed already unmuted without throwing", () => {
    const audio = createDriveAudio(false);
    expect(audio.muted).toBe(false);
    audio.dispose();
  });
});
