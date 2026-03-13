import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Attachment } from "discord.js";

import type { AppConfig } from "../config/env.js";
import { Logger } from "../utils/logger.js";

const execFile = promisify(execFileCallback);

export class LocalWhisperTranscriber {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async transcribeAttachment(attachment: Attachment): Promise<string> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-voice-"));
    try {
      const sourceExtension = getAttachmentExtension(attachment);
      const sourcePath = path.join(tempDir, `input${sourceExtension}`);

      const downloadStartedAt = performance.now();
      const response = await fetch(attachment.url);
      if (!response.ok) {
        throw new Error(`Failed to download voice attachment: ${response.status} ${response.statusText}`);
      }

      const fileBuffer = Buffer.from(await response.arrayBuffer());
      await writeFile(sourcePath, fileBuffer);
      const downloadElapsedMs = Math.round(performance.now() - downloadStartedAt);
      this.logger.info("Voice attachment downloaded", {
        name: attachment.name,
        sizeBytes: fileBuffer.byteLength,
        elapsedMs: downloadElapsedMs,
      });

      return await this.transcribeAudioFile(sourcePath, attachment.name);
    } catch (error) {
      this.logger.warn("Local whisper transcription failed", error);
      throw error instanceof Error ? error : new Error("Voice transcription failed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async transcribeAudioFile(sourcePath: string, sourceName = path.basename(sourcePath)): Promise<string> {
    const whisperPath = this.config.whisperCppPath ?? "whisper-cli";
    const whisperModelPath = this.config.whisperModelPath;
    const whisperLanguage = this.config.whisperLanguage ?? "pl";
    const ffmpegPath = this.config.ffmpegPath ?? "ffmpeg";

    if (!whisperModelPath) {
      throw new Error("Voice transcription is not configured: WHISPER_MODEL_PATH is missing");
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-voice-"));
    try {
      const wavPath = path.join(tempDir, "audio.wav");
      const outputPrefix = path.join(tempDir, "transcript");
      const transcriptPath = `${outputPrefix}.txt`;

      const decodeStartedAt = performance.now();
      await execFile(ffmpegPath, ["-y", "-i", sourcePath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath]);
      const decodeElapsedMs = Math.round(performance.now() - decodeStartedAt);
      this.logger.info("Voice attachment decoded with ffmpeg", {
        name: sourceName,
        elapsedMs: decodeElapsedMs,
      });

      const transcriptionStartedAt = performance.now();
      const whisperArgs = ["-m", whisperModelPath, "-f", wavPath, "-l", whisperLanguage, "-otxt", "-of", outputPrefix, "-np"];
      if (this.config.whisperThreads) {
        whisperArgs.push("-t", String(this.config.whisperThreads));
      }
      if (this.config.whisperProcessors) {
        whisperArgs.push("-p", String(this.config.whisperProcessors));
      }
      if (this.config.whisperNoSpeechThreshold !== undefined) {
        whisperArgs.push("-nth", String(this.config.whisperNoSpeechThreshold));
      }
      if (this.config.whisperMaxLen) {
        whisperArgs.push("-ml", String(this.config.whisperMaxLen));
      }
      if (this.config.whisperSplitOnWord) {
        whisperArgs.push("-sow");
      }
      if (this.config.whisperPrompt) {
        whisperArgs.push("--prompt", this.config.whisperPrompt);
      }
      if (this.config.whisperUseVad) {
        whisperArgs.push("--vad");
      }

      await execFile(whisperPath, whisperArgs);
      const transcriptionElapsedMs = Math.round(performance.now() - transcriptionStartedAt);

      const transcript = (await readFile(transcriptPath, "utf8")).trim();
      if (!transcript) {
        throw new Error("Voice transcription returned an empty transcript");
      }

      this.logger.info("Voice attachment transcribed with whisper", {
        name: sourceName,
        elapsedMs: transcriptionElapsedMs,
        language: whisperLanguage,
        whisperArgs,
        transcript,
      });

      return transcript;
    } catch (error) {
      this.logger.warn("Local whisper transcription failed", error);
      throw error instanceof Error ? error : new Error("Voice transcription failed");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

function getAttachmentExtension(attachment: Attachment): string {
  const explicitExt = path.extname(attachment.name || "");
  if (explicitExt) {
    return explicitExt;
  }

  const contentType = attachment.contentType?.toLowerCase() ?? "";
  if (contentType.includes("ogg")) {
    return ".ogg";
  }
  if (contentType.includes("mpeg")) {
    return ".mp3";
  }
  if (contentType.includes("wav")) {
    return ".wav";
  }
  if (contentType.includes("mp4")) {
    return ".mp4";
  }

  return ".ogg";
}
