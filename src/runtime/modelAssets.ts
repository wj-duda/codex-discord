import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { AppConfig } from "../config/env.js";
import { CODEX_DISCORD_MODELS_DIR } from "../config/env.js";
import { Logger } from "../utils/logger.js";

const MODELS_DIR = CODEX_DISCORD_MODELS_DIR;
const MESSAGE_AUDIO_DIR = path.join(MODELS_DIR, "messages");
const MESSAGE_AUDIO_INDEX_PATH = path.join(MESSAGE_AUDIO_DIR, "index.json");

type MessageAudioIndex = Record<string, string>;

export async function ensureModelAssets(config: AppConfig, logger: Logger): Promise<AppConfig> {
  await mkdir(MODELS_DIR, { recursive: true });
  await mkdir(MESSAGE_AUDIO_DIR, { recursive: true });

  const whisperModelPath = await resolveAsset(config.whisperModelPath, logger, "whisper model");
  const piperModelPath = await resolveAsset(config.piperModelPath, logger, "piper model");
  const piperModelConfigPath = await resolveAsset(config.piperModelConfigPath, logger, "piper model config");
  const messageAudioIndex = await loadMessageAudioIndex();
  const discordStartupSfx = await resolveMessageAudioVariants(config.discordStartupSfx, logger, messageAudioIndex, "startup sfx");
  const discordShutdownSfx = await resolveMessageAudioVariants(
    config.discordShutdownSfx,
    logger,
    messageAudioIndex,
    "shutdown sfx",
  );
  const discordWorkingSfx = await resolveMessageAudioVariants(config.discordWorkingSfx, logger, messageAudioIndex, "working sfx");
  const discordStartupMessages = await resolveMessageAudioVariants(
    config.discordStartupMessages,
    logger,
    messageAudioIndex,
    "startup messages",
  );
  const discordShutdownMessages = await resolveMessageAudioVariants(
    config.discordShutdownMessages,
    logger,
    messageAudioIndex,
    "shutdown messages",
  );
  const discordVoiceListeningMessages = await resolveMessageAudioVariants(
    config.discordVoiceListeningMessages,
    logger,
    messageAudioIndex,
    "voice listening messages",
  );
  const discordVoiceCapturedMessages = await resolveMessageAudioVariants(
    config.discordVoiceCapturedMessages,
    logger,
    messageAudioIndex,
    "voice captured messages",
  );
  const discordVoiceProcessingMessages = await resolveMessageAudioVariants(
    config.discordVoiceProcessingMessages,
    logger,
    messageAudioIndex,
    "voice processing messages",
  );
  const discordVoiceRejectedMessages = await resolveMessageAudioVariants(
    config.discordVoiceRejectedMessages,
    logger,
    messageAudioIndex,
    "voice rejected messages",
  );
  const discordVoiceStoppedMessages = await resolveMessageAudioVariants(
    config.discordVoiceStoppedMessages,
    logger,
    messageAudioIndex,
    "voice stopped messages",
  );
  const discordCodexWorkingMessages = await resolveMessageAudioVariants(
    config.discordCodexWorkingMessages,
    logger,
    messageAudioIndex,
    "codex working messages",
  );
  const discordCodexStartMessages = await resolveMessageAudioVariants(
    config.discordCodexStartMessages,
    logger,
    messageAudioIndex,
    "codex start messages",
  );
  const discordCodexReasoningMessages = await resolveMessageAudioVariants(
    config.discordCodexReasoningMessages,
    logger,
    messageAudioIndex,
    "codex reasoning messages",
  );
  const discordCodexToolMessages = await resolveMessageAudioVariants(
    config.discordCodexToolMessages,
    logger,
    messageAudioIndex,
    "codex tool messages",
  );
  const discordCodexPlanMessages = await resolveMessageAudioVariants(
    config.discordCodexPlanMessages,
    logger,
    messageAudioIndex,
    "codex plan messages",
  );

  return {
    ...config,
    discordStartupSfx,
    discordShutdownSfx,
    discordWorkingSfx,
    discordStartupMessages,
    discordShutdownMessages,
    discordVoiceListeningMessages,
    discordVoiceCapturedMessages,
    discordVoiceProcessingMessages,
    discordVoiceRejectedMessages,
    discordVoiceStoppedMessages,
    discordCodexWorkingMessages,
    discordCodexStartMessages,
    discordCodexReasoningMessages,
    discordCodexToolMessages,
    discordCodexPlanMessages,
    whisperModelPath,
    piperModelPath,
    piperModelConfigPath,
  };
}

async function resolveAsset(value: string | undefined, logger: Logger, label: string): Promise<string | undefined> {
  if (!value) {
    return undefined;
  }

  if (!isHttpUrl(value)) {
    return value;
  }

  const filename = getFilenameFromUrl(value);
  const targetPath = path.join(MODELS_DIR, filename);

  if (await fileExists(targetPath)) {
    logger.info(`Model ready: ${label}`, { path: targetPath });
    return targetPath;
  }

  logger.info(`Downloading ${label}`, { url: value, path: targetPath });
  const startedAt = performance.now();
  const response = await fetch(value, { headers: getAssetRequestHeaders(value) });
  if (!response.ok) {
    throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const tempPath = `${targetPath}.part`;
  await writeFile(tempPath, bytes);
  await rename(tempPath, targetPath);

  logger.info(`Downloaded ${label}`, {
    path: targetPath,
    sizeBytes: bytes.byteLength,
    elapsedMs: Math.round(performance.now() - startedAt),
  });

  return targetPath;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

async function resolveMessageAudioVariants(
  values: string[],
  logger: Logger,
  index: MessageAudioIndex,
  label: string,
): Promise<string[]> {
  const resolved: string[] = [];
  for (const value of values) {
    const resolvedValue = await resolveMessageAudioVariant(value, logger, index, label);
    if (resolvedValue) {
      resolved.push(resolvedValue);
    }
  }

  return resolved.length > 0 ? resolved : values;
}

async function resolveMessageAudioVariant(
  value: string | undefined,
  logger: Logger,
  index: MessageAudioIndex,
  label: string,
): Promise<string | undefined> {
  if (!value || !isHttpUrl(value)) {
    return value;
  }

  const existingFilename = index[value];
  if (existingFilename) {
    const existingPath = path.join(MESSAGE_AUDIO_DIR, existingFilename);
    if (await fileExists(existingPath)) {
      logger.info(`Message audio ready: ${label}`, { url: value, path: existingPath });
      return existingPath;
    }
  }

  const guid = existingFilename ?? `${randomUUID()}${getExtensionFromUrl(value)}`;
  const targetPath = path.join(MESSAGE_AUDIO_DIR, guid);
  try {
    logger.info(`Downloading message audio: ${label}`, { url: value, path: targetPath });
    const startedAt = performance.now();
    const response = await fetch(value, { headers: getAssetRequestHeaders(value) });
    if (!response.ok) {
      throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const tempPath = `${targetPath}.part`;
    await writeFile(tempPath, bytes);
    await rename(tempPath, targetPath);

    index[value] = guid;
    await saveMessageAudioIndex(index);

    logger.info(`Downloaded message audio: ${label}`, {
      url: value,
      path: targetPath,
      guid,
      sizeBytes: bytes.byteLength,
      elapsedMs: Math.round(performance.now() - startedAt),
    });

    return targetPath;
  } catch (error) {
    logger.warn(`Failed to cache message audio for ${label}, using original source`, {
      url: value,
      error: error instanceof Error ? error.message : String(error),
    });
    return value;
  }
}

async function loadMessageAudioIndex(): Promise<MessageAudioIndex> {
  try {
    const raw = await readFile(MESSAGE_AUDIO_INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
        ),
      );
    }
  } catch {
    return {};
  }

  return {};
}

async function saveMessageAudioIndex(index: MessageAudioIndex): Promise<void> {
  const tempPath = `${MESSAGE_AUDIO_INDEX_PATH}.part`;
  await writeFile(tempPath, JSON.stringify(index, null, 2));
  await rename(tempPath, MESSAGE_AUDIO_INDEX_PATH);
}

function getFilenameFromUrl(value: string): string {
  const url = new URL(value);
  const pathname = url.pathname;
  return path.basename(pathname) || "model.bin";
}

function getExtensionFromUrl(value: string): string {
  const basename = getFilenameFromUrl(value);
  const ext = path.extname(basename).toLowerCase();
  return ext || ".bin";
}

function getAssetRequestHeaders(value: string): Record<string, string> | undefined {
  try {
    const url = new URL(value);
    if (url.hostname !== "static.wikia.nocookie.net") {
      return undefined;
    }

    return {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      Accept: "*/*",
      Referer: "https://leagueoflegends.fandom.com/wiki/Tahm_Kench/LoL/Audio",
      Origin: "https://leagueoflegends.fandom.com",
    };
  } catch {
    return undefined;
  }
}
