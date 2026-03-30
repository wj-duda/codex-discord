import { describe, expect, it } from "vitest";

import { TurnSpeechRuntime } from "../src/discord/turnSpeechRuntime.js";
import type { VoicePlaybackObservation } from "../src/discord/voiceSpeech.js";

describe("TurnSpeechRuntime", () => {
  it("plays live sentences in order as soon as they are complete", async () => {
    const spokenTexts: string[] = [];
    const runtime = new TurnSpeechRuntime({
      speak: async (text, _label, onPlaybackFinished) => {
        spokenTexts.push(text);
        onPlaybackFinished(createPlaybackEvent(text, false));
      },
    });

    runtime.appendLiveText("I am checking");
    runtime.appendLiveText(" the logs. I am");
    runtime.appendLiveText(" fixing the logger.");

    await runtime.waitForDrain();

    expect(spokenTexts).toEqual(["I am checking the logs.", "I am fixing the logger."]);
  });

  it("keeps already spoken summary sentences and plays only the missing suffix", async () => {
    const spokenTexts: string[] = [];
    const runtime = new TurnSpeechRuntime({
      speak: async (text, _label, onPlaybackFinished) => {
        spokenTexts.push(text);
        onPlaybackFinished(createPlaybackEvent(text, false));
      },
    });

    runtime.appendLiveText("I checked the logs.");
    await runtime.waitForDrain();

    await runtime.finalize("I checked the logs. I added regression tests.");

    expect(spokenTexts).toEqual(["I checked the logs.", "I added regression tests."]);
  });

  it("retries the sentence from summary after interrupted playback", async () => {
    const spokenTexts: string[] = [];
    let interruptedFirstAttempt = false;
    const runtime = new TurnSpeechRuntime({
      speak: async (text, _label, onPlaybackFinished) => {
        spokenTexts.push(text);
        if (!interruptedFirstAttempt) {
          interruptedFirstAttempt = true;
          onPlaybackFinished(createPlaybackEvent(text, true));
          return;
        }

        onPlaybackFinished(createPlaybackEvent(text, false));
      },
    });

    runtime.appendLiveText("I fixed the logger.");
    await runtime.finalize("I fixed the logger.");

    expect(spokenTexts).toEqual(["I fixed the logger.", "I fixed the logger."]);
  });
});

function createPlaybackEvent(text: string, interrupted: boolean): VoicePlaybackObservation {
  return {
    text,
    interrupted,
    elapsedMs: interrupted ? 120 : 240,
    estimatedPlaybackMs: 240,
  };
}
