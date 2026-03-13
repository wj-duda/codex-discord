import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

const ROOT_DIR = process.cwd();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const CODEX_DISCORD_DIR = path.join(ROOT_DIR, ".codex-discord");
const MODELS_DIR = path.join(CODEX_DISCORD_DIR, "models");
const MESSAGE_AUDIO_DIR = path.join(MODELS_DIR, "messages");
const MESSAGE_AUDIO_INDEX_PATH = path.join(MESSAGE_AUDIO_DIR, "index.json");
const SFX_DIR = path.join(PACKAGE_ROOT_DIR, "assets", "defaults", "sfx");
const LEGACY_THREAD_MAP_PATH = path.join(ROOT_DIR, ".codex-discord.json");
const LEGACY_MODELS_DIR = path.join(ROOT_DIR, "models");
const THREAD_MAP_PATH = path.join(CODEX_DISCORD_DIR, "memory.json");
const DEFAULT_MESSAGES_CONFIG_PATH = path.join(MODELS_DIR, "messages.json");

const ASSET_ENV_VARS = [
  ["WHISPER_MODEL_PATH", "whisper model"],
  ["PIPER_MODEL_PATH", "piper model"],
  ["PIPER_MODEL_CONFIG_PATH", "piper model config"],
];

const MESSAGE_AUDIO_ENV_VARS = [
  ["DISCORD_STARTUP_SFX", "startup sfx"],
  ["DISCORD_SHUTDOWN_SFX", "shutdown sfx"],
  ["DISCORD_WORKING_SFX", "working sfx"],
];

const BINARY_ENV_VARS = [
  ["FFMPEG_PATH", "ffmpeg"],
  ["WHISPER_CPP_PATH", "whisper-cli"],
  ["PIPER_PATH", "piper"],
];

async function main() {
  loadDotenv({ override: false });

  await migrateLegacyLayout();
  await mkdir(CODEX_DISCORD_DIR, { recursive: true });
  await mkdir(MODELS_DIR, { recursive: true });
  await mkdir(MESSAGE_AUDIO_DIR, { recursive: true });
  await mkdir(SFX_DIR, { recursive: true });
  await ensureDefaultMessagesConfig();
  logInfo(`codex-discord directory ready: ${CODEX_DISCORD_DIR}`);
  logInfo(`models directory ready: ${MODELS_DIR}`);
  logInfo(`message audio directory ready: ${MESSAGE_AUDIO_DIR}`);

  for (const [envName, label] of BINARY_ENV_VARS) {
    const configuredPath = process.env[envName]?.trim();
    if (!configuredPath) {
      continue;
    }

    const exists = await fileExists(configuredPath);
    if (exists) {
      logInfo(`${label} configured: ${configuredPath}`);
      continue;
    }

    logWarn(`${label} path from ${envName} does not exist: ${configuredPath}`);
  }

  for (const [envName, label] of ASSET_ENV_VARS) {
    const value = process.env[envName]?.trim();
    if (!value) {
      logInfo(`${envName} is not set, skipping ${label}`);
      continue;
    }

    if (!isHttpUrl(value)) {
      const exists = await fileExists(value);
      if (exists) {
        logInfo(`${label} already available: ${value}`);
      } else {
        logWarn(`${label} path from ${envName} does not exist yet: ${value}`);
      }
      continue;
    }

    const filename = getFilenameFromUrl(value);
    const targetPath = path.join(MODELS_DIR, filename);
    if (await fileExists(targetPath)) {
      logInfo(`${label} already downloaded: ${targetPath}`);
      continue;
    }

    await downloadAsset(value, targetPath, label);
  }

  const messageAudioIndex = await loadMessageAudioIndex();
  const messagesConfig = await loadMessagesConfig();

  for (const [envName, label] of MESSAGE_AUDIO_ENV_VARS) {
    await ensureMessageAudioValue(resolveConfiguredSfxPath(envName, process.env[envName]), label, messageAudioIndex);
  }

  for (const [label, value] of [
    ["startup sfx", messagesConfig.discordStartupSfx],
    ["shutdown sfx", messagesConfig.discordShutdownSfx],
    ["working sfx", messagesConfig.discordWorkingSfx],
  ]) {
    for (const variant of value) {
      await ensureMessageAudioValue(variant, label, messageAudioIndex);
    }
  }

  for (const [label, values] of [
    ["startup messages", messagesConfig.discordStartupMessages],
    ["shutdown messages", messagesConfig.discordShutdownMessages],
    ["voice listening messages", messagesConfig.discordVoiceListeningMessages],
    ["voice captured messages", messagesConfig.discordVoiceCapturedMessages],
    ["voice processing messages", messagesConfig.discordVoiceProcessingMessages],
    ["voice rejected messages", messagesConfig.discordVoiceRejectedMessages],
    ["voice stopped messages", messagesConfig.discordVoiceStoppedMessages],
    ["codex working messages", messagesConfig.discordCodexWorkingMessages],
    ["codex start messages", messagesConfig.discordCodexStartMessages],
    ["codex reasoning messages", messagesConfig.discordCodexReasoningMessages],
    ["codex tool messages", messagesConfig.discordCodexToolMessages],
    ["codex plan messages", messagesConfig.discordCodexPlanMessages],
  ]) {
    for (const value of values) {
      await ensureMessageAudioValue(value, label, messageAudioIndex);
    }
  }
}

async function downloadAsset(url, targetPath, label) {
  logInfo(`downloading ${label}: ${url}`);
  const startedAt = performance.now();
  const response = await fetch(url, { headers: getAssetRequestHeaders(url) });
  if (!response.ok) {
    throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const tempPath = `${targetPath}.part`;
  await writeFile(tempPath, bytes);
  await rename(tempPath, targetPath);

  logInfo(
    `downloaded ${label}: ${targetPath} (${formatBytes(bytes.byteLength)}, ${Math.round(performance.now() - startedAt)} ms)`,
  );
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function migrateLegacyLayout() {
  await mkdir(CODEX_DISCORD_DIR, { recursive: true });

  if (await fileExists(LEGACY_THREAD_MAP_PATH)) {
    if (!(await fileExists(THREAD_MAP_PATH))) {
      await rename(LEGACY_THREAD_MAP_PATH, THREAD_MAP_PATH);
      logInfo(`moved ${LEGACY_THREAD_MAP_PATH} -> ${THREAD_MAP_PATH}`);
    } else {
      const merged = mergeThreadStores(
        await readThreadStoreSafe(THREAD_MAP_PATH),
        await readThreadStoreSafe(LEGACY_THREAD_MAP_PATH),
      );
      await writeFile(THREAD_MAP_PATH, `${JSON.stringify(merged, null, 2)}\n`);
      await rm(LEGACY_THREAD_MAP_PATH, { force: true });
      logInfo(`merged ${LEGACY_THREAD_MAP_PATH} into ${THREAD_MAP_PATH}`);
    }
  }

  if (await fileExists(LEGACY_MODELS_DIR)) {
    await mkdir(MODELS_DIR, { recursive: true });
    await cp(LEGACY_MODELS_DIR, MODELS_DIR, { recursive: true, force: false, errorOnExist: false });
    await rm(LEGACY_MODELS_DIR, { recursive: true, force: true });
    logInfo(`moved ${LEGACY_MODELS_DIR} -> ${MODELS_DIR}`);
  }
}

async function ensureDefaultMessagesConfig() {
  const targetPath = process.env.DISCORD_MESSAGES_PATH?.trim() || DEFAULT_MESSAGES_CONFIG_PATH;
  if (await fileExists(targetPath)) {
    return;
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(getDefaultMessagesConfig(), null, 2)}\n`);
  logInfo(`created messages config: ${targetPath}`);
}

async function readThreadStoreSafe(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      threads: parsed?.threads ?? {},
    };
  } catch {
    return { threads: {} };
  }
}

function mergeThreadStores(preferred, incoming) {
  const merged = { ...preferred.threads };

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

async function ensureMessageAudioValue(value, label, index) {
  if (!value) {
    return;
  }

  if (!isHttpUrl(value)) {
    return;
  }

  const existingFilename = index[value];
  if (existingFilename) {
    const existingPath = path.join(MESSAGE_AUDIO_DIR, existingFilename);
    if (await fileExists(existingPath)) {
      logInfo(`${label} already downloaded: ${existingPath}`);
      return;
    }
  }

  const guid = existingFilename ?? `${randomUUID()}${getExtensionFromUrl(value)}`;
  const targetPath = path.join(MESSAGE_AUDIO_DIR, guid);
  await downloadAsset(value, targetPath, label);
  index[value] = guid;
  await saveMessageAudioIndex(index);
}

function isHttpUrl(value) {
  return value.startsWith("http://") || value.startsWith("https://");
}

function resolveConfiguredSfxPath(envName, value) {
  const normalized = value?.trim();
  if (!normalized) {
    return normalized;
  }

  const lower = normalized.toLowerCase();
  if (envName === "DISCORD_STARTUP_SFX" && ["rain", "startup", "startup-rain", "startup-rain.wav"].includes(lower)) {
    return path.join(SFX_DIR, "startup.wav");
  }

  if (envName === "DISCORD_SHUTDOWN_SFX" && ["thunder", "shutdown", "shutdown-thunder", "shutdown-thunder.wav"].includes(lower)) {
    return path.join(SFX_DIR, "shutdown.wav");
  }

  if (envName === "DISCORD_WORKING_SFX" && ["keyboard", "keyboard.wav"].includes(lower)) {
    return path.join(SFX_DIR, "keyboard.wav");
  }

  return normalized;
}

function getFilenameFromUrl(value) {
  const url = new URL(value);
  return path.basename(url.pathname) || "asset.bin";
}

function getExtensionFromUrl(value) {
  return path.extname(getFilenameFromUrl(value)) || ".bin";
}

async function loadMessagesConfig() {
  const targetPath = process.env.DISCORD_MESSAGES_PATH?.trim() || DEFAULT_MESSAGES_CONFIG_PATH;

  try {
    const raw = await readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      discordStartupSfx: normalizeMessageList(parsed.discordStartupSfx),
      discordShutdownSfx: normalizeMessageList(parsed.discordShutdownSfx),
      discordWorkingSfx: normalizeMessageList(parsed.discordWorkingSfx),
      discordStartupMessages: normalizeMessageList(parsed.discordStartupMessages),
      discordShutdownMessages: normalizeMessageList(parsed.discordShutdownMessages),
      discordVoiceListeningMessages: normalizeMessageList(parsed.discordVoiceListeningMessages),
      discordVoiceCapturedMessages: normalizeMessageList(parsed.discordVoiceCapturedMessages),
      discordVoiceProcessingMessages: normalizeMessageList(parsed.discordVoiceProcessingMessages),
      discordVoiceRejectedMessages: normalizeMessageList(parsed.discordVoiceRejectedMessages),
      discordVoiceStoppedMessages: normalizeMessageList(parsed.discordVoiceStoppedMessages),
      discordCodexWorkingMessages: normalizeMessageList(parsed.discordCodexWorkingMessages),
      discordCodexStartMessages: normalizeMessageList(parsed.discordCodexStartMessages),
      discordCodexReasoningMessages: normalizeMessageList(parsed.discordCodexReasoningMessages),
      discordCodexToolMessages: normalizeMessageList(parsed.discordCodexToolMessages),
      discordCodexPlanMessages: normalizeMessageList(parsed.discordCodexPlanMessages),
    };
  } catch {
    return getDefaultMessagesConfig();
  }
}

function getDefaultMessagesConfig() {
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

function normalizeMessageList(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}

async function loadMessageAudioIndex() {
  try {
    const raw = await readFile(MESSAGE_AUDIO_INDEX_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    return {};
  }

  return {};
}

async function saveMessageAudioIndex(index) {
  const tempPath = `${MESSAGE_AUDIO_INDEX_PATH}.part`;
  await writeFile(tempPath, JSON.stringify(index, null, 2));
  await rename(tempPath, MESSAGE_AUDIO_INDEX_PATH);
}

function getAssetRequestHeaders(value) {
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

function formatBytes(value) {
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function logInfo(message) {
  console.log(`[setup] ${message}`);
}

function logWarn(message) {
  console.warn(`[setup] WARN ${message}`);
}

main().catch((error) => {
  console.error("[setup] FAILED", error instanceof Error ? error.message : error);
  process.exit(1);
});
