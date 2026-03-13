import { config as loadDotenv } from "dotenv";
import path from "node:path";

loadDotenv({ override: true });

export interface AppConfig {
  discordBotToken: string;
  discordChannelId: string;
  discordVoiceChannelId?: string;
  discordStartupSfx?: string;
  discordShutdownSfx?: string;
  discordWorkingSfx?: string;
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
  piperPath?: string;
  piperModelPath?: string;
  piperModelConfigPath?: string;
  piperLengthScale?: number;
  piperNoiseScale?: number;
  piperNoiseW?: number;
  piperSentenceSilence?: number;
  codexCwd: string;
  codexModel?: string;
  codexThreadMapPath: string;
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
  const discordStartupSfx = process.env.DISCORD_STARTUP_SFX?.trim();
  const discordShutdownSfx = process.env.DISCORD_SHUTDOWN_SFX?.trim();
  const discordWorkingSfx = process.env.DISCORD_WORKING_SFX?.trim();
  const ffmpegPath = process.env.FFMPEG_PATH?.trim();
  const whisperCppPath = process.env.WHISPER_CPP_PATH?.trim();
  const whisperModelPath = process.env.WHISPER_MODEL_PATH?.trim();
  const whisperLanguage = process.env.WHISPER_LANGUAGE?.trim();
  const piperPath = process.env.PIPER_PATH?.trim();
  const piperModelPath = process.env.PIPER_MODEL_PATH?.trim();
  const piperModelConfigPath = process.env.PIPER_MODEL_CONFIG_PATH?.trim();
  const piperLengthScale = parseOptionalNumber(process.env.PIPER_LENGTH_SCALE);
  const piperNoiseScale = parseOptionalNumber(process.env.PIPER_NOISE_SCALE);
  const piperNoiseW = parseOptionalNumber(process.env.PIPER_NOISE_W);
  const piperSentenceSilence = parseOptionalNumber(process.env.PIPER_SENTENCE_SILENCE);
  const codexThreadMapPath =
    process.env.CODEX_BRIDGE_PATH?.trim() ||
    process.env.CODEX_THREAD_MAP_PATH?.trim() ||
    path.join(process.cwd(), ".codex-discord.json");

  return {
    discordBotToken: process.env.DISCORD_BOT_TOKEN!.trim(),
    discordChannelId: process.env.DISCORD_CHANNEL_ID!.trim(),
    discordVoiceChannelId: discordVoiceChannelId || undefined,
    discordStartupSfx: discordStartupSfx || undefined,
    discordShutdownSfx: discordShutdownSfx || undefined,
    discordWorkingSfx: discordWorkingSfx || undefined,
    discordStartupMessages: parseMessageVariants(
      "DISCORD_STARTUP_MESSAGES",
      process.env.DISCORD_STARTUP_MESSAGE,
      ["I'm back."],
    ),
    discordShutdownMessages: parseMessageVariants(
      "DISCORD_SHUTDOWN_MESSAGES",
      process.env.DISCORD_SHUTDOWN_MESSAGE,
      ["I'm going offline."],
    ),
    discordVoiceListeningMessages: parseMessageVariants(
      "DISCORD_VOICE_LISTENING_MESSAGES",
      process.env.DISCORD_VOICE_LISTENING_MESSAGE,
      ["Słucham."],
    ),
    discordVoiceCapturedMessages: parseMessageVariants(
      "DISCORD_VOICE_CAPTURED_MESSAGES",
      undefined,
      ["Mam to, spisuję."],
    ),
    discordVoiceProcessingMessages: parseMessageVariants(
      "DISCORD_VOICE_PROCESSING_MESSAGES",
      process.env.DISCORD_VOICE_PROCESSING_MESSAGE,
      ["Zaraz się tym zajmę."],
    ),
    discordVoiceRejectedMessages: parseMessageVariants(
      "DISCORD_VOICE_REJECTED_MESSAGES",
      undefined,
      ["Kompletnie nie rozumiem, co tam wpadło."],
    ),
    discordVoiceStoppedMessages: parseMessageVariants(
      "DISCORD_VOICE_STOPPED_MESSAGES",
      undefined,
      ["Dobra, zatrzymuję się."],
    ),
    discordCodexWorkingMessages: parseMessageVariants(
      "DISCORD_CODEX_WORKING_MESSAGES",
      undefined,
      ["Aha, no popatrzmy."],
    ),
    discordCodexStartMessages: parseMessageVariants(
      "DISCORD_CODEX_START_MESSAGES",
      undefined,
      ["Dobra."],
    ),
    discordCodexReasoningMessages: parseMessageVariants(
      "DISCORD_CODEX_REASONING_MESSAGES",
      undefined,
      ["Hmm."],
    ),
    discordCodexToolMessages: parseMessageVariants(
      "DISCORD_CODEX_TOOL_MESSAGES",
      undefined,
      ["Już."],
    ),
    discordCodexPlanMessages: parseMessageVariants(
      "DISCORD_CODEX_PLAN_MESSAGES",
      undefined,
      ["Okej."],
    ),
    ffmpegPath: ffmpegPath || undefined,
    whisperCppPath: whisperCppPath || undefined,
    whisperModelPath: whisperModelPath || undefined,
    whisperLanguage: whisperLanguage || "pl",
    piperPath: piperPath || undefined,
    piperModelPath: piperModelPath || undefined,
    piperModelConfigPath: piperModelConfigPath || undefined,
    piperLengthScale,
    piperNoiseScale,
    piperNoiseW,
    piperSentenceSilence,
    codexCwd: process.env.CODEX_CWD?.trim() || process.cwd(),
    codexModel: codexModel || undefined,
    codexThreadMapPath,
    logLevel: getLogLevel(),
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

function parseMessageVariants(name: string, legacyValue: string | undefined, fallback: string[]): string[] {
  const raw = process.env[name]?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const normalized = parsed.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean);
        if (normalized.length > 0) {
          return normalized;
        }
      }
    } catch {
      return [raw];
    }
  }

  const legacy = legacyValue?.trim();
  if (legacy) {
    return [legacy];
  }

  return fallback;
}
