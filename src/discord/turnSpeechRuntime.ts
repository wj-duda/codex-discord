import { TurnSpeechCoordinator, type VoicePlaybackObservation } from "./voiceSpeech.js";

export interface TurnSpeechRuntimePlayback {
  speak(
    text: string,
    label: string,
    onPlaybackFinished: (event: VoicePlaybackObservation) => void,
  ): Promise<void>;
}

export class TurnSpeechRuntime {
  private readonly coordinator = new TurnSpeechCoordinator();
  private speechLoopPromise: Promise<void> | null = null;

  constructor(
    private readonly playback: TurnSpeechRuntimePlayback,
    private readonly labelPrefix = "codex_turn",
  ) {
    this.coordinator.on("sentenceQueued", () => {
      void this.runSpeechLoop();
    });
  }

  appendLiveText(text: string): void {
    this.coordinator.appendLiveText(text);
  }

  appendSummaryDelta(delta: string): void {
    this.coordinator.appendSummaryDelta(delta);
  }

  appendSummaryBreak(): void {
    this.coordinator.appendSummaryBreak();
  }

  async finalize(summaryText: string): Promise<void> {
    this.coordinator.reconcileWithSummary(summaryText);
    await this.coordinator.waitForDrain();
  }

  async waitForDrain(): Promise<void> {
    await this.coordinator.waitForDrain();
  }

  private runSpeechLoop(): Promise<void> {
    if (this.speechLoopPromise) {
      return this.speechLoopPromise;
    }

    this.speechLoopPromise = (async () => {
      while (true) {
        const sentence = this.coordinator.takeNextQueuedSentence();
        if (!sentence) {
          break;
        }

        let playbackObserved = false;
        await this.playback.speak(sentence.text, `${this.labelPrefix}_${sentence.id}`, (event) => {
          playbackObserved = true;
          if (event.interrupted) {
            this.coordinator.markSentenceInterrupted(sentence.id);
            return;
          }

          this.coordinator.markSentenceSpoken(sentence.id);
        });

        if (!playbackObserved) {
          this.coordinator.markSentenceInterrupted(sentence.id);
        }
      }
    })().finally(() => {
      this.speechLoopPromise = null;
      if (this.coordinator.hasQueuedSentences()) {
        void this.runSpeechLoop();
      }
    });

    return this.speechLoopPromise;
  }
}
