#!/usr/bin/env node
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { config as loadDotenv } from "dotenv";

import { runBridge } from "./app.js";
import {
  CODEX_DISCORD_DIR,
  CODEX_DISCORD_MEMORY_PATH,
  CODEX_DISCORD_MODELS_DIR,
  CODEX_DISCORD_SFX_DIR,
  DEFAULT_SHUTDOWN_SFX_PATH,
  DEFAULT_STARTUP_SFX_PATH,
  DEFAULT_WORKING_SFX_PATH,
  getMissingRequiredEnvVars,
  loadConfig,
} from "./config/env.js";
import { ensureModelAssets } from "./runtime/modelAssets.js";
import { Logger } from "./utils/logger.js";

const ROOT_DIR = process.cwd();
const ENV_PATH = path.join(ROOT_DIR, ".env");
const THREAD_MAP_PATH = CODEX_DISCORD_MEMORY_PATH;
const MODELS_DIR = CODEX_DISCORD_MODELS_DIR;
const SFX_DIR = CODEX_DISCORD_SFX_DIR;
const LEGACY_THREAD_MAP_PATH = path.join(ROOT_DIR, ".codex-discord.json");
const LEGACY_MODELS_DIR = path.join(ROOT_DIR, "models");
const DEFAULT_MESSAGES_CONFIG_PATH = path.join(CODEX_DISCORD_MODELS_DIR, "messages.json");

const ENV_TEMPLATE = `DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=
DISCORD_VOICE_CHANNEL_ID=
DISCORD_STARTUP_SFX=${DEFAULT_STARTUP_SFX_PATH}
DISCORD_SHUTDOWN_SFX=${DEFAULT_SHUTDOWN_SFX_PATH}
DISCORD_WORKING_SFX=${DEFAULT_WORKING_SFX_PATH}
DISCORD_MESSAGES_PATH=${DEFAULT_MESSAGES_CONFIG_PATH}
FFMPEG_PATH=ffmpeg
WHISPER_CPP_PATH=whisper-cli
WHISPER_MODEL_PATH=https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
WHISPER_LANGUAGE=pl
WHISPER_THREADS=16
WHISPER_PROCESSORS=1
WHISPER_NO_SPEECH_THRESHOLD=0.45
WHISPER_MAX_LEN=96
WHISPER_SPLIT_ON_WORD=true
WHISPER_PROMPT=Transcribe mixed Polish and English speech from Discord. Expect casual conversation, programming terms, English commands, file names, package names, and tool names. Preserve the original language of each word when possible.
WHISPER_USE_VAD=false
PIPER_PATH=piper
PIPER_MODEL_PATH=https://huggingface.co/rhasspy/piper-voices/resolve/main/pl/pl_PL/gosia/medium/pl_PL-gosia-medium.onnx
PIPER_MODEL_CONFIG_PATH=https://huggingface.co/rhasspy/piper-voices/resolve/main/pl/pl_PL/gosia/medium/pl_PL-gosia-medium.onnx.json
PIPER_LENGTH_SCALE=1.12
PIPER_NOISE_SCALE=0.42
PIPER_NOISE_W=0.45
PIPER_SENTENCE_SILENCE=0.28
CODEX_CWD=${ROOT_DIR}
CODEX_MODEL=
CODEX_THREAD_MAP_PATH=${THREAD_MAP_PATH}
LOG_LEVEL=info
`;

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";

  switch (command) {
    case "init":
      await runInit();
      return;
    case "setup":
      await runSetup();
      return;
    case "doctor":
      await runDoctor();
      return;
    case "start":
      await runBridge();
      return;
    case "-h":
    case "--help":
    case "help":
      printHelp();
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

async function runInit(): Promise<void> {
  await migrateLegacyLayout();
  await mkdir(CODEX_DISCORD_DIR, { recursive: true });
  await mkdir(MODELS_DIR, { recursive: true });
  await mkdir(SFX_DIR, { recursive: true });
  await ensureDefaultMessagesConfig();
  await ensureFile(path.join(MODELS_DIR, ".gitkeep"), "");

  if (!(await fileExists(THREAD_MAP_PATH))) {
    await writeFile(THREAD_MAP_PATH, '{\n  "threads": {}\n}\n', "utf8");
    console.log(`[init] created ${THREAD_MAP_PATH}`);
  } else {
    console.log(`[init] exists ${THREAD_MAP_PATH}`);
  }

  if (!(await fileExists(ENV_PATH))) {
    await writeFile(ENV_PATH, ENV_TEMPLATE, "utf8");
    console.log(`[init] created ${ENV_PATH}`);
  } else {
    console.log(`[init] exists ${ENV_PATH}`);
  }

  console.log("[init] ready");
  console.log("[init] next steps:");
  console.log("  1. Fill DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID in .env");
  console.log("  2. Optionally set DISCORD_VOICE_CHANNEL_ID");
  console.log(`  3. Review ${path.relative(ROOT_DIR, SFX_DIR)}/ if you want custom cues`);
  console.log("  4. Run: codex-discord doctor");
  console.log("  5. Run: codex-discord setup");
  console.log("  6. Run: codex-discord start");
}

async function runSetup(): Promise<void> {
  await migrateLegacyLayout();
  loadDotenv({ path: ENV_PATH, override: false });
  if (!(await fileExists(ENV_PATH))) {
    console.error("[setup] missing .env");
    console.error("[setup] run: codex-discord init");
    process.exit(1);
  }

  const logger = new Logger("info");
  const config = loadConfig();

  await mkdir(MODELS_DIR, { recursive: true });
  await mkdir(SFX_DIR, { recursive: true });
  await ensureDefaultMessagesConfig();
  await ensureModelAssets(config, logger);

  await reportBinary("ffmpeg", config.ffmpegPath);
  await reportBinary("whisper-cli", config.whisperCppPath);
  await reportBinary("piper", config.piperPath);

  console.log("[setup] done");
}

async function runDoctor(): Promise<void> {
  await migrateLegacyLayout();
  loadDotenv({ path: ENV_PATH, override: false });
  const missing = getMissingRequiredEnvVars();
  let hasErrors = false;

  if (!(await fileExists(ENV_PATH))) {
    hasErrors = true;
    console.error("[doctor] missing .env");
    console.error("[doctor] run: codex-discord init");
  } else {
    console.log(`[doctor] found ${ENV_PATH}`);
  }

  if (missing.length > 0) {
    hasErrors = true;
    console.error("[doctor] missing required env vars:");
    for (const name of missing) {
      console.error(`- ${name}`);
    }
  } else {
    console.log("[doctor] required Discord env vars are present");
  }

  if (await fileExists(ENV_PATH)) {
    await ensureDefaultMessagesConfig();
    const config = loadConfig();
    await reportBinary("ffmpeg", config.ffmpegPath);
    await reportBinary("whisper-cli", config.whisperCppPath);
    await reportBinary("piper", config.piperPath);

    await reportAsset("whisper model", config.whisperModelPath);
    await reportAsset("piper model", config.piperModelPath);
    await reportAsset("piper model config", config.piperModelConfigPath);
  }

  if (!(await fileExists(path.join(MODELS_DIR, ".gitkeep")))) {
    console.warn(`[doctor] WARN ${path.relative(ROOT_DIR, path.join(MODELS_DIR, ".gitkeep"))} is missing; run: codex-discord init`);
  }

  if (hasErrors) {
    process.exit(1);
  }

  console.log("[doctor] looks good");
}

async function reportBinary(label: string, configuredPath: string | undefined): Promise<void> {
  if (!configuredPath) {
    console.warn(`[doctor] WARN ${label} is not configured`);
    return;
  }

  if (await looksResolvable(configuredPath)) {
    console.log(`[doctor] ok ${label}: ${configuredPath}`);
    return;
  }

  console.warn(`[doctor] WARN ${label} was not found: ${configuredPath}`);
}

async function reportAsset(label: string, value: string | undefined): Promise<void> {
  if (!value) {
    console.warn(`[doctor] WARN ${label} is not configured`);
    return;
  }

  if (isHttpUrl(value)) {
    console.log(`[doctor] ok ${label}: will download from ${value}`);
    return;
  }

  if (await fileExists(value)) {
    console.log(`[doctor] ok ${label}: ${value}`);
    return;
  }

  console.warn(`[doctor] WARN ${label} does not exist yet: ${value}`);
}

function printHelp(): void {
  console.log("codex-discord <command>");
  console.log("");
  console.log("Commands:");
  console.log("  init    Create .env, .codex-discord/, and default assets paths");
  console.log("  setup   Download models and validate binary paths");
  console.log("  doctor  Check config, binaries, and model paths");
  console.log("  start   Start the Discord bridge");
}

async function migrateLegacyLayout(): Promise<void> {
  await mkdir(CODEX_DISCORD_DIR, { recursive: true });

  if (await fileExists(LEGACY_THREAD_MAP_PATH)) {
    if (!(await fileExists(THREAD_MAP_PATH))) {
      await rename(LEGACY_THREAD_MAP_PATH, THREAD_MAP_PATH);
      console.log(`[migrate] moved ${LEGACY_THREAD_MAP_PATH} -> ${THREAD_MAP_PATH}`);
    } else {
      const merged = mergeThreadStores(
        await readThreadStoreSafe(THREAD_MAP_PATH),
        await readThreadStoreSafe(LEGACY_THREAD_MAP_PATH),
      );
      await writeFile(THREAD_MAP_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
      await rm(LEGACY_THREAD_MAP_PATH, { force: true });
      console.log(`[migrate] merged ${LEGACY_THREAD_MAP_PATH} into ${THREAD_MAP_PATH}`);
    }
  }

  if (await fileExists(LEGACY_MODELS_DIR)) {
    await mkdir(MODELS_DIR, { recursive: true });
    await cp(LEGACY_MODELS_DIR, MODELS_DIR, { recursive: true, force: false, errorOnExist: false });
    await rm(LEGACY_MODELS_DIR, { recursive: true, force: true });
    console.log(`[migrate] moved ${LEGACY_MODELS_DIR} -> ${MODELS_DIR}`);
  }
}

async function ensureDefaultMessagesConfig(): Promise<void> {
  const targetPath = process.env.DISCORD_MESSAGES_PATH?.trim() || DEFAULT_MESSAGES_CONFIG_PATH;
  if (await fileExists(targetPath)) {
    return;
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(getDefaultMessagesConfig(), null, 2)}\n`, "utf8");
  console.log(`[init] created messages config ${targetPath}`);
}

function getDefaultMessagesConfig(): Record<string, string | string[]> {
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

async function readThreadStoreSafe(filePath: string): Promise<{ threads: Record<string, ThreadRecordLike> }> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { threads?: Record<string, ThreadRecordLike> };
    return {
      threads: parsed.threads ?? {},
    };
  } catch {
    return { threads: {} };
  }
}

function mergeThreadStores(
  preferred: { threads: Record<string, ThreadRecordLike> },
  incoming: { threads: Record<string, ThreadRecordLike> },
): { threads: Record<string, ThreadRecordLike> } {
  const merged: Record<string, ThreadRecordLike> = { ...preferred.threads };

  for (const [conversationId, incomingRecord] of Object.entries(incoming.threads)) {
    const existingRecord = merged[conversationId];
    if (!existingRecord) {
      merged[conversationId] = incomingRecord;
      continue;
    }

    const preferredTime = Date.parse(existingRecord.updatedAt ?? "");
    const incomingTime = Date.parse(incomingRecord.updatedAt ?? "");
    const useIncoming = Number.isFinite(incomingTime) && (!Number.isFinite(preferredTime) || incomingTime > preferredTime);
    const newer = useIncoming ? incomingRecord : existingRecord;
    const older = useIncoming ? existingRecord : incomingRecord;

    merged[conversationId] = {
      codexThreadId: newer.codexThreadId || older.codexThreadId,
      lastProcessedDiscordMessageId:
        newer.lastProcessedDiscordMessageId || older.lastProcessedDiscordMessageId,
      updatedAt: newer.updatedAt || older.updatedAt || new Date(0).toISOString(),
    };
  }

  return { threads: merged };
}

interface ThreadRecordLike {
  codexThreadId: string;
  lastProcessedDiscordMessageId?: string;
  updatedAt?: string;
}

async function ensureFile(filePath: string, contents: string): Promise<void> {
  if (await fileExists(filePath)) {
    return;
  }

  await writeFile(filePath, contents, "utf8");
}

async function looksResolvable(value: string): Promise<boolean> {
  if (value.includes("/") || value.includes("\\")) {
    return fileExists(value);
  }

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    if (await fileExists(path.join(entry, value))) {
      return true;
    }
  }

  return false;
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

void main().catch((error) => {
  console.error("[codex-discord] FAILED", error instanceof Error ? error.message : error);
  process.exit(1);
});
