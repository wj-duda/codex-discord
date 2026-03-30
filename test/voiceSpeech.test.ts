import { describe, expect, it } from "vitest";

import { TurnSpeechCoordinator } from "../src/discord/voiceSpeech.js";

describe("TurnSpeechCoordinator", () => {
  it("emits queued sentences only after a full sentence boundary is reached", () => {
    const coordinator = new TurnSpeechCoordinator();
    const queuedTexts: string[] = [];

    coordinator.on("sentenceQueued", (sentence) => {
      queuedTexts.push(sentence.text);
    });

    coordinator.appendLiveText("I am checking");
    expect(queuedTexts).toEqual([]);

    coordinator.appendLiveText(" the logs. I am");
    expect(queuedTexts).toEqual(["I am checking the logs."]);

    coordinator.appendLiveText(" fixing the logger.");
    expect(queuedTexts).toEqual(["I am checking the logs.", "I am fixing the logger."]);
  });

  it("keeps a matching live prefix and appends only the missing summary suffix", () => {
    const coordinator = new TurnSpeechCoordinator();
    const removedTexts: string[] = [];

    coordinator.on("sentenceRemoved", (sentence) => {
      removedTexts.push(sentence.text);
    });

    coordinator.appendLiveText("I checked the logs. I fixed the logger. I updated the tests.");

    const spoken = coordinator.takeNextQueuedSentence();
    expect(spoken?.text).toBe("I checked the logs.");
    expect(spoken).not.toBeNull();
    coordinator.markSentenceSpoken(spoken!.id);

    coordinator.reconcileWithSummary("I checked the logs. I fixed the logger. I added regression tests.");

    expect(removedTexts).toEqual(["I updated the tests."]);

    const queued = drainQueuedSentences(coordinator);
    expect(queued.map((sentence) => sentence.text)).toEqual([
      "I fixed the logger.",
      "I added regression tests.",
    ]);
    expect(queued.map((sentence) => sentence.source)).toEqual(["live", "summary"]);
  });

  it("does not duplicate a sentence that is already processing when summary arrives", () => {
    const coordinator = new TurnSpeechCoordinator();

    coordinator.appendLiveText("I checked the logs. I fixed the logger.");

    const processing = coordinator.takeNextQueuedSentence();
    expect(processing?.text).toBe("I checked the logs.");
    expect(processing).not.toBeNull();

    coordinator.reconcileWithSummary("I checked the logs. I fixed the logger. I added tests.");

    const queued = drainQueuedSentences(coordinator);
    expect(queued.map((sentence) => sentence.text)).toEqual(["I fixed the logger.", "I added tests."]);

    coordinator.markSentenceSpoken(processing!.id);
  });

  it("waits for drain until the processing sentence settles", async () => {
    const coordinator = new TurnSpeechCoordinator();

    coordinator.appendLiveText("I checked the logs.");

    const processing = coordinator.takeNextQueuedSentence();
    expect(processing).not.toBeNull();

    let drained = false;
    const drainPromise = coordinator.waitForDrain().then(() => {
      drained = true;
    });

    await Promise.resolve();
    expect(drained).toBe(false);

    coordinator.markSentenceSpoken(processing!.id);
    await drainPromise;
    expect(drained).toBe(true);
  });

  it("requeues the summary sentence after interrupted playback", () => {
    const coordinator = new TurnSpeechCoordinator();

    coordinator.appendLiveText("I fixed the logger.");

    const processing = coordinator.takeNextQueuedSentence();
    expect(processing).not.toBeNull();
    coordinator.markSentenceInterrupted(processing!.id);

    coordinator.reconcileWithSummary("I fixed the logger.");

    const queued = drainQueuedSentences(coordinator);
    expect(queued.map((sentence) => sentence.text)).toEqual(["I fixed the logger."]);
    expect(queued[0]?.source).toBe("summary");
  });

  it("reconciles an accumulated summary built from deltas", () => {
    const coordinator = new TurnSpeechCoordinator();

    coordinator.appendLiveText("I checked the logs. I fixed the logger.");

    const spoken = coordinator.takeNextQueuedSentence();
    expect(spoken).not.toBeNull();
    coordinator.markSentenceSpoken(spoken!.id);

    coordinator.appendSummaryDelta("I checked the logs. I fixed");
    coordinator.appendSummaryDelta(" the logger.");
    coordinator.appendSummaryBreak();
    coordinator.appendSummaryDelta("I added tests.");
    coordinator.reconcileWithSummary();

    const queued = drainQueuedSentences(coordinator);
    expect(queued.map((sentence) => sentence.text)).toEqual([
      "I fixed the logger.",
      "I added tests.",
    ]);
  });

  it("queues summary sentences as soon as a full summary sentence is completed", () => {
    const coordinator = new TurnSpeechCoordinator();

    coordinator.appendLiveText("I checked the logs.");

    const spoken = coordinator.takeNextQueuedSentence();
    expect(spoken).not.toBeNull();
    coordinator.markSentenceSpoken(spoken!.id);

    coordinator.appendSummaryDelta("I checked the logs. I added");
    expect(coordinator.takeNextQueuedSentence()).toBeNull();

    coordinator.appendSummaryDelta(" tests.");

    const queued = drainQueuedSentences(coordinator);
    expect(queued.map((sentence) => sentence.text)).toEqual(["I added tests."]);
    expect(queued[0]?.source).toBe("summary");
  });
});

function drainQueuedSentences(coordinator: TurnSpeechCoordinator): Array<{ text: string; source: "live" | "summary" }> {
  const drained: Array<{ text: string; source: "live" | "summary" }> = [];

  while (true) {
    const sentence = coordinator.takeNextQueuedSentence();
    if (!sentence) {
      return drained;
    }

    drained.push({ text: sentence.text, source: sentence.source });
    coordinator.markSentenceInterrupted(sentence.id);
  }
}
