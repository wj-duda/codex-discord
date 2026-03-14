import { config as loadDotenv } from "dotenv";
import { readFileSync } from "node:fs";
import path from "node:path";

loadDotenv({ override: true, quiet: true });

const PACKAGE_ROOT_DIR = path.resolve(__dirname, "..", "..");

export const CODEX_DISCORD_DIR = path.join(process.cwd(), ".codex-discord");
export const CODEX_DISCORD_INCOMING_DIR = path.join(CODEX_DISCORD_DIR, "incoming");
export const CODEX_DISCORD_MODELS_DIR = path.join(CODEX_DISCORD_DIR, "models");
export const CODEX_DISCORD_MEMORY_PATH = path.join(CODEX_DISCORD_DIR, "memory.json");
export const CODEX_DISCORD_MESSAGES_PATH = path.join(CODEX_DISCORD_MODELS_DIR, "messages.json");
export const CODEX_DISCORD_SFX_DIR = path.join(PACKAGE_ROOT_DIR, "assets", "defaults", "sfx");
export const DEFAULT_STARTUP_SFX_PATH = path.join(CODEX_DISCORD_SFX_DIR, "startup.wav");
export const DEFAULT_SHUTDOWN_SFX_PATH = path.join(CODEX_DISCORD_SFX_DIR, "shutdown.wav");
export const DEFAULT_WORKING_SFX_PATH = path.join(CODEX_DISCORD_SFX_DIR, "keyboard.wav");

export interface ParsedVariantEntry {
  kind: "text" | "url" | "file";
  value: string;
}

export interface MessagesConfig {
  discordStartupSfx: string[];
  discordShutdownSfx: string[];
  discordWorkingSfx: string[];
  discordStartupMessages: string[];
  discordShutdownMessages: string[];
  discordVoiceListeningMessages: string[];
  discordVoiceCapturedMessages: string[];
  discordVoiceProcessingMessages: string[];
  discordVoiceRejectedMessages: string[];
  discordVoiceStoppedMessages: string[];
  discordCodexWorkingMessages: string[];
  discordCodexStartMessages: string[];
  discordCodexReasoningMessages: string[];
  discordCodexToolMessages: string[];
  discordCodexPlanMessages: string[];
}

export interface AppConfig {
  discordBotToken: string;
  discordChannelId: string;
  discordVoiceChannelId?: string;
  discordStartupSfx: string[];
  discordShutdownSfx: string[];
  discordWorkingSfx: string[];
  discordStartupMessages: string[];
  discordShutdownMessages: string[];
  discordVoiceListeningMessages: string[];
  discordVoiceCapturedMessages: string[];
  discordVoiceProcessingMessages: string[];
  discordVoiceRejectedMessages: string[];
  discordVoiceStoppedMessages: string[];
  discordCodexWorkingMessages: string[];
  discordCodexStartMessages: string[];
  discordCodexReasoningMessages: string[];
  discordCodexToolMessages: string[];
  discordCodexPlanMessages: string[];
  ffmpegPath?: string;
  whisperCppPath?: string;
  whisperModelPath?: string;
  whisperLanguage?: string;
  whisperThreads?: number;
  whisperProcessors?: number;
  whisperNoSpeechThreshold?: number;
  whisperMaxLen?: number;
  whisperSplitOnWord?: boolean;
  whisperPrompt?: string;
  whisperUseVad?: boolean;
  piperPath?: string;
  piperModelPath?: string;
  piperModelConfigPath?: string;
  piperLengthScale?: number;
  piperNoiseScale?: number;
  piperNoiseW?: number;
  piperSentenceSilence?: number;
  codexCwd: string;
  codexModel?: string;
  codexPrePrompt?: string;
  codexThreadMapPath: string;
  messagesConfigPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

const REQUIRED_ENV_VARS = ["DISCORD_BOT_TOKEN", "DISCORD_CHANNEL_ID"] as const;

export function getMissingRequiredEnvVars(): string[] {
  return REQUIRED_ENV_VARS.filter((name) => !process.env[name]?.trim());
}

function getLogLevel(): AppConfig["logLevel"] {
  const level = process.env.LOG_LEVEL?.trim().toLowerCase();
  switch (level) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return level;
    default:
      return "info";
  }
}

export function loadConfig(): AppConfig {
  const codexModel = process.env.CODEX_MODEL?.trim();
  const discordVoiceChannelId = process.env.DISCORD_VOICE_CHANNEL_ID?.trim();
  const ffmpegPath = process.env.FFMPEG_PATH?.trim();
  const whisperCppPath = process.env.WHISPER_CPP_PATH?.trim();
  const whisperModelPath = process.env.WHISPER_MODEL_PATH?.trim();
  const whisperLanguage = process.env.WHISPER_LANGUAGE?.trim();
  const whisperThreads = parseOptionalInteger(process.env.WHISPER_THREADS);
  const whisperProcessors = parseOptionalInteger(process.env.WHISPER_PROCESSORS);
  const whisperNoSpeechThreshold = parseOptionalNumber(process.env.WHISPER_NO_SPEECH_THRESHOLD);
  const whisperMaxLen = parseOptionalInteger(process.env.WHISPER_MAX_LEN);
  const whisperSplitOnWord = parseOptionalBoolean(process.env.WHISPER_SPLIT_ON_WORD) ?? false;
  const whisperPrompt = process.env.WHISPER_PROMPT?.trim();
  const whisperUseVad = parseOptionalBoolean(process.env.WHISPER_USE_VAD) ?? false;
  const piperPath = process.env.PIPER_PATH?.trim();
  const piperModelPath = process.env.PIPER_MODEL_PATH?.trim();
  const piperModelConfigPath = process.env.PIPER_MODEL_CONFIG_PATH?.trim();
  const piperLengthScale = parseOptionalNumber(process.env.PIPER_LENGTH_SCALE);
  const piperNoiseScale = parseOptionalNumber(process.env.PIPER_NOISE_SCALE);
  const piperNoiseW = parseOptionalNumber(process.env.PIPER_NOISE_W);
  const piperSentenceSilence = parseOptionalNumber(process.env.PIPER_SENTENCE_SILENCE);
  const codexPrePrompt = process.env.CODEX_PRE_PROMPT?.trim();
  const codexThreadMapPath =
    process.env.CODEX_BRIDGE_PATH?.trim() ||
    process.env.CODEX_THREAD_MAP_PATH?.trim() ||
    CODEX_DISCORD_MEMORY_PATH;
  const messagesConfigPath =
    process.env.DISCORD_MESSAGES_PATH?.trim() ||
    CODEX_DISCORD_MESSAGES_PATH;
  const messagesConfig = loadMessagesConfig(messagesConfigPath);

  return {
    discordBotToken: process.env.DISCORD_BOT_TOKEN!.trim(),
    discordChannelId: process.env.DISCORD_CHANNEL_ID!.trim(),
    discordVoiceChannelId: discordVoiceChannelId || undefined,
    discordStartupSfx: messagesConfig.discordStartupSfx,
    discordShutdownSfx: messagesConfig.discordShutdownSfx,
    discordWorkingSfx: messagesConfig.discordWorkingSfx,
    discordStartupMessages: messagesConfig.discordStartupMessages,
    discordShutdownMessages: messagesConfig.discordShutdownMessages,
    discordVoiceListeningMessages: messagesConfig.discordVoiceListeningMessages,
    discordVoiceCapturedMessages: messagesConfig.discordVoiceCapturedMessages,
    discordVoiceProcessingMessages: messagesConfig.discordVoiceProcessingMessages,
    discordVoiceRejectedMessages: messagesConfig.discordVoiceRejectedMessages,
    discordVoiceStoppedMessages: messagesConfig.discordVoiceStoppedMessages,
    discordCodexWorkingMessages: messagesConfig.discordCodexWorkingMessages,
    discordCodexStartMessages: messagesConfig.discordCodexStartMessages,
    discordCodexReasoningMessages: messagesConfig.discordCodexReasoningMessages,
    discordCodexToolMessages: messagesConfig.discordCodexToolMessages,
    discordCodexPlanMessages: messagesConfig.discordCodexPlanMessages,
    ffmpegPath: ffmpegPath || undefined,
    whisperCppPath: whisperCppPath || undefined,
    whisperModelPath: whisperModelPath || undefined,
    whisperLanguage: whisperLanguage || "pl",
    whisperThreads,
    whisperProcessors,
    whisperNoSpeechThreshold,
    whisperMaxLen,
    whisperSplitOnWord,
    whisperPrompt: whisperPrompt || undefined,
    whisperUseVad,
    piperPath: piperPath || undefined,
    piperModelPath: piperModelPath || undefined,
    piperModelConfigPath: piperModelConfigPath || undefined,
    piperLengthScale,
    piperNoiseScale,
    piperNoiseW,
    piperSentenceSilence,
    codexCwd: process.env.CODEX_CWD?.trim() || process.cwd(),
    codexModel: codexModel || undefined,
    codexPrePrompt: codexPrePrompt || undefined,
    codexThreadMapPath,
    messagesConfigPath,
    logLevel: getLogLevel(),
  };
}

export function buildDefaultMessagesConfig(): MessagesConfig {
  return {
    discordStartupSfx: [
      "https://static.wikia.nocookie.net/leagueoflegends/images/0/0e/Tahm_Kench_Select_SFX.ogg/revision/latest?cb=20230629000325",
    ],
    discordShutdownSfx: [
      "https://static.wikia.nocookie.net/leagueoflegends/images/9/9f/Tahm_Kench_Ban.ogg/revision/latest?cb=20200810155503",
    ],
    discordWorkingSfx: [
      "https://cs1.mp3.pm/download/62081497/emlIb0lYS210Z1JVcEU4UlJCaTlVK01SNUMzMmVhb3VYV1ZUNXZCNTRSZmxLRmtUUm9jQjdlUWRMUDB4V0Z1b2ZsZlJ4aDZ5U2ZyalRIV1ViYmU1TkJWM3ZiUXFERnZBWFJtWE1zTW9Dai92ODlyNjdOQmdudDEwYWd6ejJDNSs/League_of_Legends_Music_-_Tahm_Kench_Login_Theme_(mp3.pm).mp3",
    ],
    discordStartupMessages: ["I'm back."],
    discordShutdownMessages: ["I'm going offline."],
    discordVoiceListeningMessages: ["I'm listening."],
    discordVoiceCapturedMessages: ["Got it."],
    discordVoiceProcessingMessages: ["Give me a second."],
    discordVoiceRejectedMessages: ["I couldn't make that out."],
    discordVoiceStoppedMessages: ["Stopping now."],
    discordCodexWorkingMessages: ["Hmm."],
    discordCodexStartMessages: ["Starting."],
    discordCodexReasoningMessages: ["Thinking."],
    discordCodexToolMessages: ["Working on it."],
    discordCodexPlanMessages: ["I have a direction."],
  };
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function resolveConfiguredSfxPath(
  value: string | undefined,
  kind: "startup" | "shutdown" | "working",
): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  const lower = normalized.toLowerCase();
  if (kind === "startup" && ["rain", "startup", "startup-rain", "startup-rain.wav"].includes(lower)) {
    return DEFAULT_STARTUP_SFX_PATH;
  }

  if (kind === "shutdown" && ["thunder", "shutdown", "shutdown-thunder", "shutdown-thunder.wav"].includes(lower)) {
    return DEFAULT_SHUTDOWN_SFX_PATH;
  }

  if (kind === "working" && ["keyboard", "keyboard.wav"].includes(lower)) {
    return DEFAULT_WORKING_SFX_PATH;
  }

  return normalized;
}

function loadMessagesConfig(filePath: string): MessagesConfig {
  const fallback = buildDefaultMessagesConfig();

  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<MessagesConfig>;
    return {
      discordStartupSfx: normalizeSfxValues(parsed.discordStartupSfx, "startup", fallback.discordStartupSfx),
      discordShutdownSfx: normalizeSfxValues(parsed.discordShutdownSfx, "shutdown", fallback.discordShutdownSfx),
      discordWorkingSfx: normalizeSfxValues(parsed.discordWorkingSfx, "working", fallback.discordWorkingSfx),
      discordStartupMessages: normalizeMessageVariants(parsed.discordStartupMessages, fallback.discordStartupMessages),
      discordShutdownMessages: normalizeMessageVariants(parsed.discordShutdownMessages, fallback.discordShutdownMessages),
      discordVoiceListeningMessages: normalizeMessageVariants(
        parsed.discordVoiceListeningMessages,
        fallback.discordVoiceListeningMessages,
      ),
      discordVoiceCapturedMessages: normalizeMessageVariants(
        parsed.discordVoiceCapturedMessages,
        fallback.discordVoiceCapturedMessages,
      ),
      discordVoiceProcessingMessages: normalizeMessageVariants(
        parsed.discordVoiceProcessingMessages,
        fallback.discordVoiceProcessingMessages,
      ),
      discordVoiceRejectedMessages: normalizeMessageVariants(
        parsed.discordVoiceRejectedMessages,
        fallback.discordVoiceRejectedMessages,
      ),
      discordVoiceStoppedMessages: normalizeMessageVariants(
        parsed.discordVoiceStoppedMessages,
        fallback.discordVoiceStoppedMessages,
      ),
      discordCodexWorkingMessages: normalizeMessageVariants(
        parsed.discordCodexWorkingMessages,
        fallback.discordCodexWorkingMessages,
      ),
      discordCodexStartMessages: normalizeMessageVariants(parsed.discordCodexStartMessages, fallback.discordCodexStartMessages),
      discordCodexReasoningMessages: normalizeMessageVariants(
        parsed.discordCodexReasoningMessages,
        fallback.discordCodexReasoningMessages,
      ),
      discordCodexToolMessages: normalizeMessageVariants(parsed.discordCodexToolMessages, fallback.discordCodexToolMessages),
      discordCodexPlanMessages: normalizeMessageVariants(parsed.discordCodexPlanMessages, fallback.discordCodexPlanMessages),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[config] Failed to read messages config from ${filePath}, using defaults: ${reason}`);
    return fallback;
  }
}

function normalizeMessageVariants(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const normalized = parseVariantEntries(value).map((entry) => entry.value);
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeSfxValues(
  value: unknown,
  kind: "startup" | "shutdown" | "working",
  fallback: string[],
): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const normalized = parseVariantEntries(value)
    .map((entry) => resolveConfiguredSfxPath(entry.value, kind))
    .filter((entry): entry is string => Boolean(entry));
  return normalized.length > 0 ? normalized : fallback;
}

export function parseVariantEntries(value: unknown): ParsedVariantEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => (typeof entry === "string" ? parseVariantEntry(entry) : null))
    .filter((entry): entry is ParsedVariantEntry => entry !== null);
}

export function parseVariantEntry(value: string): ParsedVariantEntry | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (/^https?:\/\//i.test(normalized)) {
    return { kind: "url", value: normalized };
  }

  if (
    /^(\/|\.{1,2}\/|~\/|[A-Za-z]:[\\/]).+/i.test(normalized) ||
    /[\\/].+\.(wav|mp3|ogg|flac|m4a)$/i.test(normalized)
  ) {
    return { kind: "file", value: normalized };
  }

  return { kind: "text", value: normalized };
}
