import { EventEmitter } from "node:events";

const LEADING_LIST_MARKER_PATTERN = /^[-+*]\s+/;
const SPEECH_COMPARISON_PUNCTUATION_PATTERN = /[.,!?;:()[\]{}"'“”‘’]/g;

export interface VoicePlaybackObservation {
  text: string;
  interrupted: boolean;
  elapsedMs: number;
  estimatedPlaybackMs: number;
}

export interface SpeechSentence {
  id: number;
  text: string;
  canonicalText: string;
  source: "live" | "summary";
  state: "queued" | "processing" | "spoken" | "interrupted" | "removed";
}

export interface TurnSpeechCoordinatorEvents {
  sentenceQueued: [SpeechSentence];
  sentenceRemoved: [SpeechSentence];
  sentenceProcessing: [SpeechSentence];
  sentenceSpoken: [SpeechSentence];
  sentenceInterrupted: [SpeechSentence];
  summaryReconciled: [{ summaryText: string }];
  drain: [];
}

export function normalizeSpeechText(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function countSpeechWords(value: string): number {
  const normalized = normalizeSpeechText(value);
  if (!normalized) {
    return 0;
  }

  return normalized.split(/\s+/).filter(Boolean).length;
}

export function splitSpeechText(value: string, sentencesPerChunk: number): string[] {
  const normalized = value.trim();
  if (!normalized) {
    return [];
  }

  const protectedText = protectSpeechText(normalized);
  const sentences =
    protectedText
      .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
      ?.map((part) => restoreProtectedSpeechText(part).trim())
      .filter(Boolean) ?? [normalized];

  const chunks: string[] = [];
  for (let index = 0; index < sentences.length; index += sentencesPerChunk) {
    const chunk = sentences.slice(index, index + sentencesPerChunk).join(" ").trim();
    if (chunk) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

export class TurnSpeechCoordinator extends EventEmitter {
  private readonly accumulator = new SentenceAccumulator();
  private readonly summaryAccumulator = new SentenceAccumulator();
  private readonly entries: SpeechSentence[] = [];
  private summarySentences: string[] = [];
  private nextSentenceId = 1;
  private summaryText = "";

  constructor() {
    super();
    this.accumulator.on("sentence", (sentence: string) => {
      this.enqueueSentence(sentence, "live");
    });
    this.summaryAccumulator.on("sentence", (sentence: string) => {
      const normalizedSentence = normalizeSpeechText(sentence);
      if (!normalizedSentence) {
        return;
      }

      this.summarySentences.push(normalizedSentence);
      this.summaryText = this.summarySentences.join(" ").trim();
      this.reconcileQueuedSummary();
    });
  }

  on<K extends keyof TurnSpeechCoordinatorEvents>(
    eventName: K,
    listener: (...args: TurnSpeechCoordinatorEvents[K]) => void,
  ): this {
    return super.on(eventName, listener);
  }

  once<K extends keyof TurnSpeechCoordinatorEvents>(
    eventName: K,
    listener: (...args: TurnSpeechCoordinatorEvents[K]) => void,
  ): this {
    return super.once(eventName, listener);
  }

  emit<K extends keyof TurnSpeechCoordinatorEvents>(eventName: K, ...args: TurnSpeechCoordinatorEvents[K]): boolean {
    return super.emit(eventName, ...args);
  }

  appendLiveText(text: string): void {
    this.accumulator.append(text);
  }

  appendSummaryDelta(delta: string): void {
    this.summaryAccumulator.append(delta);
  }

  appendSummaryBreak(): void {
    this.summaryAccumulator.flush();
  }

  reconcileWithSummary(summaryText?: string): void {
    if (typeof summaryText === "string") {
      this.summaryText = summaryText;
      this.summarySentences = splitSpeechText(normalizeSpeechText(summaryText), 1);
      this.summaryAccumulator.clear();
    } else {
      this.summaryAccumulator.flush();
      this.summaryText = this.summarySentences.join(" ").trim();
    }

    this.reconcileQueuedSummary();
  }

  private reconcileQueuedSummary(): void {
    this.accumulator.flush();
    const normalizedSummary = this.summarySentences;
    if (normalizedSummary.length === 0) {
      this.emit("summaryReconciled", { summaryText: "" });
      this.emitDrainIfNeeded();
      return;
    }

    const activeEntries = this.entries.filter(
      (entry) => entry.state === "spoken" || entry.state === "processing" || entry.state === "queued",
    );

    let matchedPrefixLength = 0;
    while (matchedPrefixLength < activeEntries.length && matchedPrefixLength < normalizedSummary.length) {
      const activeEntry = activeEntries[matchedPrefixLength];
      const summarySentence = normalizedSummary[matchedPrefixLength];
      if (!activeEntry || !summarySentence) {
        break;
      }

      if (activeEntry.canonicalText !== canonicalizeSpeechForComparison(summarySentence)) {
        break;
      }

      matchedPrefixLength += 1;
    }

    for (const entry of activeEntries.slice(matchedPrefixLength)) {
      if (entry.state !== "queued") {
        continue;
      }

      entry.state = "removed";
      this.emit("sentenceRemoved", entry);
    }

    for (const sentence of normalizedSummary.slice(matchedPrefixLength)) {
      this.enqueueSentence(sentence, "summary");
    }

    this.emit("summaryReconciled", { summaryText: normalizedSummary.join(" ").trim() });
    this.emitDrainIfNeeded();
  }

  takeNextQueuedSentence(): SpeechSentence | null {
    const nextEntry = this.entries.find((entry) => entry.state === "queued") ?? null;
    if (!nextEntry) {
      return null;
    }

    nextEntry.state = "processing";
    this.emit("sentenceProcessing", nextEntry);
    return nextEntry;
  }

  markSentenceSpoken(sentenceId: number): void {
    const entry = this.entries.find((candidate) => candidate.id === sentenceId);
    if (!entry || entry.state !== "processing") {
      return;
    }

    entry.state = "spoken";
    this.emit("sentenceSpoken", entry);
    this.emitDrainIfNeeded();
  }

  markSentenceInterrupted(sentenceId: number): void {
    const entry = this.entries.find((candidate) => candidate.id === sentenceId);
    if (!entry || entry.state !== "processing") {
      return;
    }

    entry.state = "interrupted";
    this.emit("sentenceInterrupted", entry);
    this.emitDrainIfNeeded();
  }

  hasQueuedSentences(): boolean {
    return this.entries.some((entry) => entry.state === "queued");
  }

  hasPendingWork(): boolean {
    return this.entries.some((entry) => entry.state === "queued" || entry.state === "processing");
  }

  waitForDrain(): Promise<void> {
    if (!this.hasPendingWork()) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.once("drain", () => {
        resolve();
      });
    });
  }

  private enqueueSentence(sentence: string, source: "live" | "summary"): void {
    const normalizedSentence = normalizeSpeechText(sentence);
    if (!normalizedSentence) {
      return;
    }

    const entry: SpeechSentence = {
      id: this.nextSentenceId,
      text: normalizedSentence,
      canonicalText: canonicalizeSpeechForComparison(normalizedSentence),
      source,
      state: "queued",
    };
    this.nextSentenceId += 1;
    this.entries.push(entry);
    this.emit("sentenceQueued", entry);
  }

  private emitDrainIfNeeded(): void {
    if (!this.hasPendingWork()) {
      this.emit("drain");
    }
  }
}

class SentenceAccumulator extends EventEmitter {
  private buffer = "";

  constructor() {
    super();
  }

  override on(eventName: "sentence", listener: (sentence: string) => void): this {
    return super.on(eventName, listener);
  }

  append(text: string): void {
    const normalizedText = text.trim();
    if (!normalizedText) {
      return;
    }

    this.buffer = this.buffer ? `${this.buffer} ${normalizedText}` : normalizedText;
    const { sentences, remainder } = extractCompleteSentences(this.buffer);
    this.buffer = remainder;

    for (const sentence of sentences) {
      this.emit("sentence", sentence);
    }
  }

  flush(): void {
    const normalizedRemainder = normalizeSpeechText(this.buffer);
    this.buffer = "";
    if (normalizedRemainder) {
      this.emit("sentence", normalizedRemainder);
    }
  }

  clear(): void {
    this.buffer = "";
  }
}

function extractCompleteSentences(value: string): { sentences: string[]; remainder: string } {
  const protectedText = protectSpeechText(value);
  const matches = [...protectedText.matchAll(/[^.!?]+[.!?]+/g)];
  if (matches.length === 0) {
    return {
      sentences: [],
      remainder: normalizeSpeechText(value),
    };
  }

  const lastMatch = matches[matches.length - 1];
  const consumedLength = (lastMatch?.index ?? 0) + (lastMatch?.[0].length ?? 0);

  return {
    sentences: matches
      .map((match) => restoreProtectedSpeechText(match[0]).trim())
      .filter(Boolean),
    remainder: restoreProtectedSpeechText(protectedText.slice(consumedLength)).trim(),
  };
}

function protectSpeechText(value: string): string {
  return value
    .replace(/\b[a-z]:\\/gi, (match) => match.replace(/\./g, "DOT_PLACEHOLDER"))
    .replace(/(^|[\s(])\.[A-Za-z0-9_-]+/g, (match) => match.replace(/\./g, "DOT_PLACEHOLDER"))
    .replace(/\b[\w/-]+\.[A-Za-z0-9_-]+\b/g, (match) => match.replace(/\./g, "DOT_PLACEHOLDER"));
}

function restoreProtectedSpeechText(value: string): string {
  return value.replace(/DOT_PLACEHOLDER/g, ".");
}

function canonicalizeSpeechForComparison(value: string): string {
  return normalizeSpeechText(value)
    .replace(LEADING_LIST_MARKER_PATTERN, "")
    .replace(SPEECH_COMPARISON_PUNCTUATION_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
