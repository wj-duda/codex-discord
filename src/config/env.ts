import { config as loadDotenv } from "dotenv";
import path from "node:path";

loadDotenv();

export interface AppConfig {
  discordBotToken: string;
  discordChannelId: string;
  discordStartupMessage?: string;
  discordShutdownMessage?: string;
  ffmpegPath?: string;
  whisperCppPath?: string;
  whisperModelPath?: string;
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
  const discordStartupMessage = process.env.DISCORD_STARTUP_MESSAGE?.trim();
  const discordShutdownMessage = process.env.DISCORD_SHUTDOWN_MESSAGE?.trim();
  const ffmpegPath = process.env.FFMPEG_PATH?.trim();
  const whisperCppPath = process.env.WHISPER_CPP_PATH?.trim();
  const whisperModelPath = process.env.WHISPER_MODEL_PATH?.trim();
  const codexThreadMapPath =
    process.env.CODEX_BRIDGE_PATH?.trim() ||
    process.env.CODEX_THREAD_MAP_PATH?.trim() ||
    path.join(process.cwd(), ".codex-discord.json");

  return {
    discordBotToken: process.env.DISCORD_BOT_TOKEN!.trim(),
    discordChannelId: process.env.DISCORD_CHANNEL_ID!.trim(),
    discordStartupMessage: discordStartupMessage === "" ? undefined : (discordStartupMessage ?? "I'm back."),
    discordShutdownMessage: discordShutdownMessage === "" ? undefined : (discordShutdownMessage ?? "I'm going offline."),
    ffmpegPath: ffmpegPath || undefined,
    whisperCppPath: whisperCppPath || undefined,
    whisperModelPath: whisperModelPath || undefined,
    codexCwd: process.env.CODEX_CWD?.trim() || process.cwd(),
    codexModel: codexModel || undefined,
    codexThreadMapPath,
    logLevel: getLogLevel(),
  };
}
