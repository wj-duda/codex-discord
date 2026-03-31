#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { config as loadDotenv, parse as parseDotenv } from "dotenv";

import { runBridge } from "./app.js";
import {
  CODEX_DISCORD_DIR,
  CODEX_DISCORD_SFX_DIR,
  CODEX_DISCORD_TASKS_DIR,
  DEFAULT_SHUTDOWN_SFX_PATH,
  DEFAULT_STARTUP_SFX_PATH,
  DEFAULT_WORKING_SFX_PATH,
  buildDefaultMessagesConfig,
  getMissingRequiredEnvVars,
  isAnyVoiceFeatureEnabled,
  isVoiceInputEnabled,
  isVoiceOutputEnabled,
  loadConfig,
  parseVariantEntry,
} from "./config/env.js";
import { ensureModelAssets } from "./runtime/modelAssets.js";
import { Logger } from "./utils/logger.js";

const ROOT_DIR = process.cwd();
const PACKAGE_ROOT_DIR = path.resolve(__dirname, "..");
const CODEX_DISCORD_ROOT_DIR = CODEX_DISCORD_DIR;
const ENV_PATH = path.join(ROOT_DIR, ".env");
const THREAD_MAP_PATH = path.join(CODEX_DISCORD_ROOT_DIR, "memory.json");
const MODELS_DIR = path.join(CODEX_DISCORD_ROOT_DIR, "models");
const TASKS_DIR = CODEX_DISCORD_TASKS_DIR;
const SFX_DIR = CODEX_DISCORD_SFX_DIR;
const MESSAGE_PACKS_DIR = path.join(PACKAGE_ROOT_DIR, "assets", "defaults", "message-packs");
const DEFAULT_MESSAGES_CONFIG_PATH = path.join(MODELS_DIR, "messages.json");
const USER_CODEX_HOME_DIR = path.join(os.homedir(), ".codex");
const LOCAL_CODEX_BINARY_PATH = path.join(
  ROOT_DIR,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "codex.cmd" : "codex",
);

interface InitOptions {
  nonInteractive: boolean;
  token?: string;
  channelId?: string;
  voiceChannelId?: string;
  prePrompt?: string;
}

interface DoctorIssue {
  code: string;
  message: string;
  action: string;
}

interface CliJsonOptions {
  json: boolean;
}

interface MessagesOptions {
  subcommand: "list" | "install";
  packName?: string;
  json: boolean;
}

interface BundledMessagePack {
  name: string;
  filePath: string;
}

interface LoadedBundledMessagePack {
  messagesConfig: Record<string, unknown>;
  envOverrides: Record<string, string>;
}

interface EnsuredBundledAssetsResult {
  downloadedPaths: string[];
  reusedPaths: string[];
}

interface StatusCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface CodexHomeStatus {
  ok: boolean;
  detail: string;
  source: "workspace" | "user-home" | "missing";
  workspacePath: string;
}

const ENV_TEMPLATE = `DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=
DISCORD_VOICE_ENABLED=
DISCORD_VOICE_INPUT_ENABLED=
DISCORD_VOICE_OUTPUT_ENABLED=
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
CODEX_PRE_PROMPT=
CODEX_THREAD_MAP_PATH=${THREAD_MAP_PATH}
CODEX_TASKS_PATH=${TASKS_DIR}
LOG_LEVEL=info
`;

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  const args = process.argv.slice(3);

  switch (command) {
    case "init":
      await runInit(parseInitOptions(args));
      return;
    case "setup":
      await runSetup();
      return;
    case "doctor":
      await runDoctor(parseCliJsonOptions(args));
      return;
    case "status":
      await runStatus(parseCliJsonOptions(args));
      return;
    case "start":
      await runBridge();
      return;
    case "messages":
      await runMessages(parseMessagesOptions(args));
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

async function runInit(options: InitOptions): Promise<void> {
  await migrateLegacyLayout();
  await mkdir(CODEX_DISCORD_ROOT_DIR, { recursive: true });
  await mkdir(MODELS_DIR, { recursive: true });
  await mkdir(TASKS_DIR, { recursive: true });
  await mkdir(SFX_DIR, { recursive: true });
  await ensureDefaultMessagesConfig();
  await ensureFile(path.join(MODELS_DIR, ".gitkeep"), "");
  await ensureFile(path.join(TASKS_DIR, ".gitkeep"), "");

  if (!(await fileExists(THREAD_MAP_PATH))) {
    await writeFile(THREAD_MAP_PATH, '{\n  "threads": {}\n}\n', "utf8");
    console.log(`[init] created ${THREAD_MAP_PATH}`);
  } else {
    console.log(`[init] exists ${THREAD_MAP_PATH}`);
  }

  if (!(await fileExists(ENV_PATH))) {
    await writeFile(ENV_PATH, ENV_TEMPLATE, "utf8");
    logInfo("init", `created ${ENV_PATH}`);
  } else {
    logInfo("init", `found ${ENV_PATH}`);
  }

  const codexHomeStatus = await resolveCodexHomeStatus(ROOT_DIR);
  if (!codexHomeStatus.ok) {
    printCodexHomeHint("init", codexHomeStatus);
  }

  const envConfig = await loadEnvFile(ENV_PATH);
  applyInitOverrides(envConfig, options);
  if (options.nonInteractive) {
    await writeEnvFile(ENV_PATH, envConfig);
    logInfo("init", "non-interactive mode enabled");
  } else if (process.stdin.isTTY && process.stdout.isTTY) {
    await promptForInitEnv(ENV_PATH, envConfig);
  } else {
    logWarn("init", "interactive setup skipped because this shell is not attached to a TTY");
    await writeEnvFile(ENV_PATH, envConfig);
  }

  logSuccess("init", "ready");
  console.log(colorize("cyan", "[init] Next steps"));
  console.log("  1. Run: codex-discord doctor");
  console.log("  2. Run: codex-discord setup");
  console.log("  3. Run: codex-discord start");
  console.log(`  4. Review ${path.relative(ROOT_DIR, SFX_DIR)}/ if you want custom cues`);
  console.log("  5. Voice auto-discovers from your setup; you can still force it with DISCORD_VOICE_ENABLED=true/false");
}

async function runSetup(): Promise<void> {
  await migrateLegacyLayout();
  loadDotenv({ path: ENV_PATH, override: false, quiet: true });
  if (!(await fileExists(ENV_PATH))) {
    logError("setup", "missing .env");
    logError("setup", "run: codex-discord init");
    process.exit(1);
  }

  const logger = new Logger("info");
  const config = loadConfig();

  await mkdir(MODELS_DIR, { recursive: true });
  await mkdir(TASKS_DIR, { recursive: true });
  await mkdir(SFX_DIR, { recursive: true });
  await ensureDefaultMessagesConfig();
  await ensureModelAssets(config, logger);

  if (isAnyVoiceFeatureEnabled(config)) {
    await reportBinary("ffmpeg", config.ffmpegPath);
  }
  if (isVoiceInputEnabled(config)) {
    await reportBinary("whisper-cli", config.whisperCppPath);
  }
  if (isVoiceOutputEnabled(config)) {
    await reportBinary("piper", config.piperPath);
  }

  logSuccess("setup", "done");
}

async function runDoctor(options: CliJsonOptions): Promise<void> {
  await migrateLegacyLayout();
  loadDotenv({ path: ENV_PATH, override: false, quiet: true });
  const missing = getMissingRequiredEnvVars();
  let configuredCodexCwd = ROOT_DIR;
  let hasErrors = false;
  const issues: DoctorIssue[] = [];
  const checks: StatusCheck[] = [];

  if (!(await fileExists(ENV_PATH))) {
    hasErrors = true;
    issues.push({
      code: "missing-env-file",
      message: `.env is missing at ${ENV_PATH}`,
      action: "Run: codex-discord init",
    });
    if (!options.json) {
      logError("doctor", "missing .env");
      logError("doctor", "run: codex-discord init");
    }
    checks.push({ name: ".env", ok: false, detail: ENV_PATH });
  } else {
    if (!options.json) {
      logInfo("doctor", `found ${ENV_PATH}`);
    }
    checks.push({ name: ".env", ok: true, detail: ENV_PATH });
  }

  if (missing.length > 0) {
    hasErrors = true;
    for (const name of missing) {
      issues.push({
        code: `missing-env-${name.toLowerCase()}`,
        message: `Required env var ${name} is missing`,
        action: `Add ${name}=... to .env`,
      });
    }
    if (!options.json) {
      logError("doctor", "missing required env vars:");
      for (const name of missing) {
        console.error(`- ${name}`);
      }
      printMissingEnvExample(missing);
    }
  } else {
    if (!options.json) {
      logSuccess("doctor", "required Discord env vars are present");
    }
    checks.push({ name: "required env vars", ok: true, detail: "DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID" });
  }

  if (await fileExists(ENV_PATH)) {
    await ensureDefaultMessagesConfig();
    const config = loadConfig();
    const voiceInputEnabled = isVoiceInputEnabled(config);
    const voiceOutputEnabled = isVoiceOutputEnabled(config);
    configuredCodexCwd = config.codexCwd;
    const hasCodex = await reportCodexBinary(options.json);
    const hasFfmpeg = isAnyVoiceFeatureEnabled(config)
      ? await reportBinary("ffmpeg", config.ffmpegPath, options.json)
      : true;
    const hasWhisper = voiceInputEnabled ? await reportBinary("whisper-cli", config.whisperCppPath, options.json) : true;
    const hasPiper = voiceOutputEnabled ? await reportBinary("piper", config.piperPath, options.json) : true;
    const messagesValidation = await validateMessagesConfigFile(config.messagesConfigPath);

    if (voiceInputEnabled) {
      await reportAsset("whisper model", config.whisperModelPath, options.json);
    }
    if (voiceOutputEnabled) {
      await reportAsset("piper model", config.piperModelPath, options.json);
      await reportAsset("piper model config", config.piperModelConfigPath, options.json);
    }
    checks.push({ name: "codex", ok: hasCodex, detail: LOCAL_CODEX_BINARY_PATH });
    checks.push({
      name: "voice mode",
      ok: true,
      detail: !isAnyVoiceFeatureEnabled(config)
        ? "text-only (default)"
        : `input=${voiceInputEnabled ? "on" : "off"}, output=${voiceOutputEnabled ? "on" : "off"}`,
    });
    if (isAnyVoiceFeatureEnabled(config)) {
      checks.push({ name: "ffmpeg", ok: hasFfmpeg, detail: config.ffmpegPath ?? "ffmpeg" });
    }
    if (voiceInputEnabled) {
      checks.push({ name: "whisper-cli", ok: hasWhisper, detail: config.whisperCppPath ?? "whisper-cli" });
    }
    if (voiceOutputEnabled) {
      checks.push({ name: "piper", ok: hasPiper, detail: config.piperPath ?? "piper" });
    }
    checks.push({
      name: "messages.json",
      ok: messagesValidation.ok,
      detail: config.messagesConfigPath,
    });
    if (!messagesValidation.ok) {
      hasErrors = true;
      issues.push(...messagesValidation.issues);
    }

    if (!hasCodex) {
      hasErrors = true;
      issues.push({
        code: "missing-codex-binary",
        message: `Local codex binary is missing at ${LOCAL_CODEX_BINARY_PATH}`,
        action: "Run: pnpm install",
      });
    }
    if (isAnyVoiceFeatureEnabled(config) && !hasFfmpeg) {
      hasErrors = true;
      issues.push({
        code: "missing-ffmpeg",
        message: `ffmpeg is not available at ${config.ffmpegPath ?? "ffmpeg"}`,
        action: "Install ffmpeg in the container or set FFMPEG_PATH in .env",
      });
    }
    if (voiceInputEnabled && !hasWhisper) {
      hasErrors = true;
      issues.push({
        code: "missing-whisper-cli",
        message: `whisper-cli is not available at ${config.whisperCppPath ?? "whisper-cli"}`,
        action: "Install whisper-cli in the container or set WHISPER_CPP_PATH in .env",
      });
    }
    if (voiceOutputEnabled && !hasPiper) {
      hasErrors = true;
      issues.push({
        code: "missing-piper",
        message: `piper is not available at ${config.piperPath ?? "piper"}`,
        action: "Install piper in the container or set PIPER_PATH in .env",
      });
    }
  }

  const codexHomeStatus = await resolveCodexHomeStatus(configuredCodexCwd);
  if (!codexHomeStatus.ok) {
    hasErrors = true;
    issues.push({
      code: "missing-codex-home",
      message: `No Codex home directory was found at ${codexHomeStatus.workspacePath} or ${USER_CODEX_HOME_DIR}`,
      action: "Install the Codex VS Code extension in this environment, provide <CODEX_CWD>/.codex, or mount ~/.codex into the container",
    });
    if (!options.json) {
      printCodexHomeHint("doctor", codexHomeStatus);
    }
    checks.push({ name: "CODEX_HOME", ok: false, detail: codexHomeStatus.detail });
  } else {
    if (!options.json) {
      logSuccess("doctor", `using ${codexHomeStatus.detail}`);
    }
    checks.push({ name: "CODEX_HOME", ok: true, detail: codexHomeStatus.detail });
  }

  if (!(await fileExists(path.join(MODELS_DIR, ".gitkeep")))) {
    if (!options.json) {
      logWarn("doctor", `${path.relative(ROOT_DIR, path.join(MODELS_DIR, ".gitkeep"))} is missing; run: codex-discord init`);
    }
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: !hasErrors,
          checks,
          issues,
        },
        null,
        2,
      ),
    );
    if (hasErrors) {
      process.exit(1);
    }
    return;
  }

  printContainerExamples(configuredCodexCwd);
  printDoctorNextActions(issues);

  if (hasErrors) {
    process.exit(1);
  }

  logSuccess("doctor", "looks good");
}

async function runStatus(options: CliJsonOptions): Promise<void> {
  await migrateLegacyLayout();
  loadDotenv({ path: ENV_PATH, override: false, quiet: true });

  const envExists = await fileExists(ENV_PATH);
  const configuredCodexCwd = envExists ? loadConfig().codexCwd : ROOT_DIR;
  const codexHomeStatus = await resolveCodexHomeStatus(configuredCodexCwd);
  const codexBinaryExists = await fileExists(LOCAL_CODEX_BINARY_PATH);
  const memoryExists = await fileExists(THREAD_MAP_PATH);
  const messagesExists = await fileExists(DEFAULT_MESSAGES_CONFIG_PATH);
  const tasksDirExists = await fileExists(TASKS_DIR);
  const checks: StatusCheck[] = [
    { name: ".env", ok: envExists, detail: ENV_PATH },
    { name: "memory.json", ok: memoryExists, detail: THREAD_MAP_PATH },
    { name: "messages.json", ok: messagesExists, detail: DEFAULT_MESSAGES_CONFIG_PATH },
    { name: "tasks/", ok: tasksDirExists, detail: TASKS_DIR },
    { name: "CODEX_HOME", ok: codexHomeStatus.ok, detail: codexHomeStatus.detail },
    { name: "codex", ok: codexBinaryExists, detail: LOCAL_CODEX_BINARY_PATH },
  ];

  if (options.json) {
    if (envExists) {
      const config = loadConfig();
      checks.push({
        name: "voice mode",
        ok: true,
        detail: !isAnyVoiceFeatureEnabled(config)
          ? "text-only (default)"
          : `input=${isVoiceInputEnabled(config) ? "on" : "off"}, output=${isVoiceOutputEnabled(config) ? "on" : "off"}`,
      });
      if (isAnyVoiceFeatureEnabled(config)) {
        checks.push({ name: "ffmpeg", ok: await looksResolvable(config.ffmpegPath ?? "ffmpeg"), detail: config.ffmpegPath ?? "ffmpeg" });
      }
      if (isVoiceInputEnabled(config)) {
        checks.push({
          name: "whisper-cli",
          ok: await looksResolvable(config.whisperCppPath ?? "whisper-cli"),
          detail: config.whisperCppPath ?? "whisper-cli",
        });
      }
      if (isVoiceOutputEnabled(config)) {
        checks.push({ name: "piper", ok: await looksResolvable(config.piperPath ?? "piper"), detail: config.piperPath ?? "piper" });
      }
      checks.push({ name: "DISCORD_BOT_TOKEN", ok: Boolean(config.discordBotToken), detail: "required env var" });
      checks.push({ name: "DISCORD_CHANNEL_ID", ok: Boolean(config.discordChannelId), detail: "required env var" });
      checks.push({
        name: "DISCORD_VOICE_CHANNEL_ID",
        ok: Boolean(config.discordVoiceChannelId),
        detail: "optional env var",
      });
    }

    console.log(
      JSON.stringify(
        {
          ok: checks.every((check) => check.ok),
          checks,
        },
        null,
        2,
      ),
    );
    return;
  }

  logInfo("status", `project root: ${ROOT_DIR}`);
  console.log(`${statusMark(envExists)} .env`);
  console.log(`${statusMark(memoryExists)} .codex-discord/memory.json`);
  console.log(`${statusMark(messagesExists)} .codex-discord/models/messages.json`);
  console.log(`${statusMark(tasksDirExists)} .codex-discord/tasks`);
  console.log(`${statusMark(codexHomeStatus.ok)} ${codexHomeStatus.detail}`);
  console.log(`${statusMark(codexBinaryExists)} ${LOCAL_CODEX_BINARY_PATH}`);

  if (envExists) {
    const config = loadConfig();
    console.log(
      `voice mode: ${
        !isAnyVoiceFeatureEnabled(config)
          ? "text-only (default)"
          : `input=${isVoiceInputEnabled(config) ? "on" : "off"}, output=${isVoiceOutputEnabled(config) ? "on" : "off"}`
      }`,
    );
    if (isAnyVoiceFeatureEnabled(config)) {
      console.log(`${statusMark(await looksResolvable(config.ffmpegPath ?? "ffmpeg"))} ffmpeg`);
    }
    if (isVoiceInputEnabled(config)) {
      console.log(`${statusMark(await looksResolvable(config.whisperCppPath ?? "whisper-cli"))} whisper-cli`);
    }
    if (isVoiceOutputEnabled(config)) {
      console.log(`${statusMark(await looksResolvable(config.piperPath ?? "piper"))} piper`);
    }
    console.log(`${statusMark(Boolean(config.discordBotToken))} DISCORD_BOT_TOKEN`);
    console.log(`${statusMark(Boolean(config.discordChannelId))} DISCORD_CHANNEL_ID`);
    console.log(`${statusMark(Boolean(config.discordVoiceChannelId))} DISCORD_VOICE_CHANNEL_ID`);
  } else {
    logWarn("status", "skipping config-derived checks because .env is missing");
  }
}

async function runMessages(options: MessagesOptions): Promise<void> {
  loadDotenv({ path: ENV_PATH, override: false, quiet: true });
  const packs = await listBundledMessagePacks();

  if (options.subcommand === "list") {
    if (options.json) {
      console.log(JSON.stringify({ packs: packs.map((pack) => pack.name) }, null, 2));
      return;
    }

    logInfo("messages", "available bundled packs:");
    for (const pack of packs) {
      console.log(`  - ${pack.name}`);
    }
    return;
  }

  const selectedPackName = options.packName ?? (await promptForMessagePackSelection(packs));
  if (!selectedPackName) {
    logError("messages", "missing pack name");
    console.log("Run: codex-discord messages list");
    process.exit(1);
  }

  const pack = packs.find((entry) => entry.name === selectedPackName);
  if (!pack) {
    logError("messages", `unknown pack: ${selectedPackName}`);
    console.log("Run: codex-discord messages list");
    process.exit(1);
  }

  const targetPath = process.env.DISCORD_MESSAGES_PATH?.trim() || DEFAULT_MESSAGES_CONFIG_PATH;
  await mkdir(path.dirname(targetPath), { recursive: true });

  let backupPath: string | null = null;
  if (await fileExists(targetPath)) {
    backupPath = `${targetPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await cp(targetPath, backupPath);
  }

  const { messagesConfig, envOverrides } = await loadBundledMessagePack(pack.filePath);
  await writeFile(targetPath, `${JSON.stringify(messagesConfig, null, 2)}\n`, "utf8");

  let envCreated = false;
  let envUpdated = false;
  let installedEnvConfig: Record<string, string> | null = null;
  let piperAssets: EnsuredBundledAssetsResult = { downloadedPaths: [], reusedPaths: [] };
  if (Object.keys(envOverrides).length > 0) {
    if (!(await fileExists(ENV_PATH))) {
      await writeFile(ENV_PATH, ENV_TEMPLATE, "utf8");
      envCreated = true;
    }

    const envConfig = await loadEnvFile(ENV_PATH);
    Object.assign(envConfig, envOverrides);
    piperAssets = await ensureBundledPiperAssets(envConfig);
    await writeEnvFile(ENV_PATH, envConfig);
    envUpdated = true;
    installedEnvConfig = envConfig;
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          installed: pack.name,
          targetPath,
          backupPath,
          envPath: envUpdated ? ENV_PATH : null,
          envCreated,
          envUpdated,
          piperModelPath: installedEnvConfig?.PIPER_MODEL_PATH ?? null,
          piperModelConfigPath: installedEnvConfig?.PIPER_MODEL_CONFIG_PATH ?? null,
          downloadedPiperAssets: piperAssets.downloadedPaths,
          reusedPiperAssets: piperAssets.reusedPaths,
        },
        null,
        2,
      ),
    );
    return;
  }

  logSuccess("messages", `installed pack ${pack.name} -> ${targetPath}`);
  if (backupPath) {
    logInfo("messages", `backup saved to ${backupPath}`);
  }
  if (envCreated) {
    logInfo("messages", `created ${ENV_PATH}`);
  }
  if (envUpdated) {
    logInfo("messages", `applied voice overrides to ${ENV_PATH}`);
  }
  for (const assetPath of piperAssets.reusedPaths) {
    logInfo("messages", `piper asset ready: ${assetPath}`);
  }
  for (const assetPath of piperAssets.downloadedPaths) {
    logInfo("messages", `piper asset downloaded: ${assetPath}`);
  }
}

async function reportBinary(label: string, configuredPath: string | undefined, silent = false): Promise<boolean> {
  if (!configuredPath) {
    if (!silent) {
      logWarn("doctor", `${label} is not configured`);
    }
    return false;
  }

  if (await looksResolvable(configuredPath)) {
    if (!silent) {
      logSuccess("doctor", `ok ${label}: ${configuredPath}`);
    }
    return true;
  }

  if (!silent) {
    logWarn("doctor", `${label} was not found: ${configuredPath}`);
  }
  return false;
}

async function reportCodexBinary(silent = false): Promise<boolean> {
  if (await fileExists(LOCAL_CODEX_BINARY_PATH)) {
    if (!silent) {
      logSuccess("doctor", `ok codex: ${LOCAL_CODEX_BINARY_PATH}`);
    }
    return true;
  }

  if (!silent) {
    logWarn("doctor", `codex was not found at ${LOCAL_CODEX_BINARY_PATH}`);
    console.log("Install project dependencies first so the local Codex CLI is available.");
    console.log("Example:");
    console.log("  pnpm install");
    console.log("");
  }
  return false;
}

async function reportAsset(label: string, value: string | undefined, silent = false): Promise<void> {
  if (!value) {
    if (!silent) {
      logWarn("doctor", `${label} is not configured`);
    }
    return;
  }

  if (isHttpUrl(value)) {
    if (!silent) {
      logSuccess("doctor", `ok ${label}: will download from ${value}`);
    }
    return;
  }

  if (await fileExists(value)) {
    if (!silent) {
      logSuccess("doctor", `ok ${label}: ${value}`);
    }
    return;
  }

  if (!silent) {
    logWarn("doctor", `${label} does not exist yet: ${value}`);
  }
}

function printHelp(): void {
  console.log("codex-discord <command>");
  console.log("");
  console.log("Commands:");
  console.log("  init    Create .env, .codex-discord/, and default assets paths");
  console.log("  setup   Download models and validate binary paths");
  console.log("  doctor  Check config, binaries, and model paths");
  console.log("  status  Show current local readiness");
  console.log("  messages  List or install bundled messages packs");
  console.log("  start   Start the Discord bridge");
  console.log("");
  console.log("Doctor / status flags:");
  console.log("  --json");
  console.log("");
  console.log("Init flags:");
  console.log("  --non-interactive");
  console.log("  --token <value>");
  console.log("  --channel <value>");
  console.log("  --voice-channel <value>");
  console.log("  --pre-prompt <value>");
  console.log("");
  console.log("Messages:");
  console.log("  messages list [--json]");
  console.log("  messages install [pack-name] [--json]");
}

async function migrateLegacyLayout(): Promise<void> {
  await mkdir(CODEX_DISCORD_ROOT_DIR, { recursive: true });
}

async function ensureDefaultMessagesConfig(): Promise<void> {
  const targetPath = process.env.DISCORD_MESSAGES_PATH?.trim() || DEFAULT_MESSAGES_CONFIG_PATH;
  if (await fileExists(targetPath)) {
    return;
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(getDefaultMessagesConfig(), null, 2)}\n`, "utf8");
  logInfo("init", `created messages config ${targetPath}`);
}

async function listBundledMessagePacks(): Promise<BundledMessagePack[]> {
  const entries = await readdir(MESSAGE_PACKS_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({
      name: entry.name.replace(/\.json$/i, ""),
      filePath: path.join(MESSAGE_PACKS_DIR, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function promptForMessagePackSelection(
  packs: BundledMessagePack[],
): Promise<string | undefined> {
  if (packs.length === 0) {
    return undefined;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }

  const rl = createInterface({ input, output });
  try {
    console.log(colorize("cyan", "\n[messages] Select a bundled pack"));
    for (const [index, pack] of packs.entries()) {
      console.log(`  ${index + 1}. ${pack.name}`);
    }
    console.log("");

    const answer = (await rl.question("Pack number or name: ")).trim();
    if (!answer) {
      return undefined;
    }

    const selectedIndex = Number.parseInt(answer, 10);
    if (Number.isFinite(selectedIndex) && selectedIndex >= 1 && selectedIndex <= packs.length) {
      return packs[selectedIndex - 1]?.name;
    }

    return answer;
  } finally {
    rl.close();
  }
}

async function loadBundledMessagePack(filePath: string): Promise<LoadedBundledMessagePack> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Bundled pack at ${filePath} must be a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  const messagesConfig = Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith("_")));
  const rawEnv = record._env;
  if (rawEnv !== undefined && (!rawEnv || typeof rawEnv !== "object" || Array.isArray(rawEnv))) {
    throw new Error(`Bundled pack _env at ${filePath} must be a JSON object`);
  }

  const envOverrides = Object.fromEntries(
    Object.entries((rawEnv ?? {}) as Record<string, unknown>).map(([key, value]) => {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error(`Bundled pack env ${key} at ${filePath} must be a string, number, or boolean`);
      }
      return [key, String(value)];
    }),
  );

  if (Object.keys(messagesConfig).length === 0) {
    throw new Error(`Bundled pack at ${filePath} does not contain any message settings`);
  }

  return { messagesConfig, envOverrides };
}

async function ensureBundledPiperAssets(
  envConfig: Record<string, string>,
): Promise<EnsuredBundledAssetsResult> {
  const result: EnsuredBundledAssetsResult = {
    downloadedPaths: [],
    reusedPaths: [],
  };

  await mkdir(MODELS_DIR, { recursive: true });

  for (const [envName, label] of [
    ["PIPER_MODEL_PATH", "piper model"],
    ["PIPER_MODEL_CONFIG_PATH", "piper model config"],
  ] as const) {
    const value = envConfig[envName]?.trim();
    if (!value || !isHttpUrl(value)) {
      continue;
    }

    const targetPath = path.join(MODELS_DIR, getFilenameFromUrl(value));
    const status = await downloadCliAsset(value, targetPath, label);
    envConfig[envName] = targetPath;
    if (status === "downloaded") {
      result.downloadedPaths.push(targetPath);
    } else {
      result.reusedPaths.push(targetPath);
    }
  }

  return result;
}

async function downloadCliAsset(
  url: string,
  targetPath: string,
  label: string,
): Promise<"downloaded" | "existing"> {
  if (await fileExists(targetPath)) {
    return "existing";
  }

  logInfo("messages", `downloading ${label}: ${url}`);
  const startedAt = performance.now();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const tempPath = `${targetPath}.part`;
  await writeFile(tempPath, bytes);
  await rename(tempPath, targetPath);

  logInfo(
    "messages",
    `downloaded ${label}: ${targetPath} (${formatBytes(bytes.byteLength)}, ${Math.round(performance.now() - startedAt)} ms)`,
  );
  return "downloaded";
}

function getDefaultMessagesConfig(): ReturnType<typeof buildDefaultMessagesConfig> {
  return buildDefaultMessagesConfig();
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

async function resolveCodexHomeStatus(codexCwd: string): Promise<CodexHomeStatus> {
  const workspacePath = path.resolve(codexCwd, ".codex");

  if (await directoryExists(workspacePath)) {
    return {
      ok: true,
      detail: `${workspacePath} (workspace)`,
      source: "workspace",
      workspacePath,
    };
  }

  if (await directoryExists(USER_CODEX_HOME_DIR)) {
    return {
      ok: true,
      detail: `${USER_CODEX_HOME_DIR} (user-home fallback)`,
      source: "user-home",
      workspacePath,
    };
  }

  return {
    ok: false,
    detail: `missing ${workspacePath} and ${USER_CODEX_HOME_DIR}`,
    source: "missing",
    workspacePath,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

async function loadEnvFile(filePath: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(filePath, "utf8");
    return parseDotenv(raw);
  } catch {
    return {};
  }
}

async function validateMessagesConfigFile(
  filePath: string,
): Promise<{ ok: boolean; issues: DoctorIssue[] }> {
  const issues: DoctorIssue[] = [];
  const fallback = buildDefaultMessagesConfig();

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: "missing-messages-config",
          message: `messages config is missing at ${filePath}`,
          action: "Run: codex-discord init",
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid-messages-json",
          message: `messages config is not valid JSON at ${filePath}`,
          action: `Fix JSON syntax: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      issues: [
        {
          code: "invalid-messages-shape",
          message: `messages config must be a JSON object at ${filePath}`,
          action: "Replace the file with an object shaped like the generated messages.json template",
        },
      ],
    };
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(fallback)) {
    const value = record[key];
    if (value === undefined) {
      continue;
    }

    if (!Array.isArray(value)) {
      issues.push({
        code: `invalid-messages-field-${key}`,
        message: `${key} must be an array in ${filePath}`,
        action: `Set ${key} to a JSON array of strings`,
      });
      continue;
    }

    for (const [index, entry] of value.entries()) {
      if (typeof entry !== "string") {
        issues.push({
          code: `invalid-messages-entry-${key}-${index}`,
          message: `${key}[${index}] must be a string in ${filePath}`,
          action: `Replace ${key}[${index}] with a string value`,
        });
        continue;
      }

      const parsedEntry = parseVariantEntry(entry);
      if (!parsedEntry) {
        issues.push({
          code: `empty-messages-entry-${key}-${index}`,
          message: `${key}[${index}] is empty in ${filePath}`,
          action: `Remove ${key}[${index}] or replace it with a non-empty string`,
        });
        continue;
      }

      if (key.endsWith("Sfx") && parsedEntry.kind === "file") {
        const candidatePath = path.isAbsolute(parsedEntry.value)
          ? parsedEntry.value
          : path.resolve(ROOT_DIR, parsedEntry.value);
        if (!(await fileExists(candidatePath))) {
          issues.push({
            code: `missing-sfx-file-${key}-${index}`,
            message: `${key}[${index}] points to a missing file: ${parsedEntry.value}`,
            action: `Create the file or replace ${key}[${index}] with a valid file path, URL, or text cue`,
          });
        }
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

async function promptForInitEnv(filePath: string, envConfig: Record<string, string>): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    console.log(colorize("cyan", "\n[init] Interactive setup"));
    console.log("Press Enter to keep the current value or leave an optional field empty.\n");

    await promptEnvValue(rl, envConfig, "DISCORD_BOT_TOKEN", "Discord bot token", true);
    await promptEnvValue(rl, envConfig, "DISCORD_CHANNEL_ID", "Discord text channel ID", true);
    await promptEnvValue(rl, envConfig, "DISCORD_VOICE_ENABLED", "Voice layer mode (true/false/blank=auto)", false);
    await promptEnvValue(rl, envConfig, "DISCORD_VOICE_CHANNEL_ID", "Discord voice channel ID", false);
    await promptEnvValue(
      rl,
      envConfig,
      "CODEX_PRE_PROMPT",
      "Optional Codex pre-prompt",
      false,
    );

    await writeEnvFile(filePath, envConfig);
    logSuccess("init", `updated ${filePath}`);
  } finally {
    rl.close();
  }
}

function applyInitOverrides(envConfig: Record<string, string>, options: InitOptions): void {
  if (options.token) {
    envConfig.DISCORD_BOT_TOKEN = options.token;
  }
  if (options.channelId) {
    envConfig.DISCORD_CHANNEL_ID = options.channelId;
  }
  if (options.voiceChannelId) {
    envConfig.DISCORD_VOICE_CHANNEL_ID = options.voiceChannelId;
  }
  if (options.prePrompt !== undefined) {
    envConfig.CODEX_PRE_PROMPT = options.prePrompt;
  }
}

async function promptEnvValue(
  rl: ReturnType<typeof createInterface>,
  envConfig: Record<string, string>,
  envName: string,
  label: string,
  required: boolean,
): Promise<void> {
  const currentValue = envConfig[envName] ?? "";
  const suffix = currentValue ? ` [current: ${maskEnvValue(envName, currentValue)}]` : "";
  const requiredNote = required ? " (required)" : " (optional)";
  const answer = (await rl.question(`${label}${requiredNote}${suffix}: `)).trim();

  if (answer) {
    envConfig[envName] = answer;
    return;
  }

  if (currentValue) {
    return;
  }

  if (required) {
    console.log(colorize("yellow", `[init] ${envName} is still empty. You can fill it later in .env.`));
  }
}

async function writeEnvFile(filePath: string, envConfig: Record<string, string>): Promise<void> {
  const templateLines = ENV_TEMPLATE.trimEnd().split("\n");
  const templateKeys = new Set<string>();
  const lines = templateLines.map((line) => {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 0) {
      return line;
    }
    const key = line.slice(0, separatorIndex);
    templateKeys.add(key);
    const fallbackValue = line.slice(separatorIndex + 1);
    const value = envConfig[key] ?? fallbackValue;
    return `${key}=${value}`;
  });

  const extraLines = Object.keys(envConfig)
    .filter((key) => !templateKeys.has(key))
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${key}=${envConfig[key] ?? ""}`);

  const outputLines = extraLines.length > 0 ? [...lines, "", ...extraLines] : lines;
  await writeFile(filePath, `${outputLines.join("\n")}\n`, "utf8");
}

function maskEnvValue(envName: string, value: string): string {
  if (!envName.includes("TOKEN")) {
    return value;
  }

  if (value.length <= 8) {
    return "********";
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function printMissingEnvExample(missing: string[]): void {
  console.log(colorize("cyan", "\n[doctor] Add these entries to your .env"));
  for (const name of missing) {
    console.log(`${name}=`);
  }
  console.log("");
}

function printCodexHomeHint(scope: "init" | "doctor", codexHomeStatus: CodexHomeStatus): void {
  logWarn(scope, `No Codex home directory found at ${codexHomeStatus.workspacePath} or ${USER_CODEX_HOME_DIR}`);
  console.log("This bridge expects an existing Codex installation in your environment.");
  console.log("It prefers <CODEX_CWD>/.codex and falls back to ~/.codex.");
  console.log("Install the Codex VS Code extension in this environment first, or make one of those directories available.");
  console.log("This wrapper reuses that existing Codex installation instead of provisioning its own.");
  console.log("");
}

function printContainerExamples(codexCwd: string): void {
  const workspaceCodexHomeDir = path.resolve(codexCwd, ".codex");
  console.log(colorize("cyan", "\n[doctor] Example container snippets"));
  console.log(colorize("bold", "\nDockerfile"));
  console.log("```dockerfile");
  console.log("RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*");
  console.log("# Install or copy whisper-cli and piper into the image.");
  console.log("# Run pnpm install so node_modules/.bin/codex exists.");
  console.log(`# Provide ${workspaceCodexHomeDir} inside the workspace or mount ${USER_CODEX_HOME_DIR} from the host.`);
  console.log("```");
  console.log(colorize("bold", "\ndevcontainer.json"));
  console.log("```json");
  console.log('{');
  console.log('  "postCreateCommand": "pnpm install && npx codex-discord doctor",');
  console.log('  "mounts": [');
  console.log(`    "source=${USER_CODEX_HOME_DIR},target=${USER_CODEX_HOME_DIR},type=bind"`);
  console.log("  ]");
  console.log("}");
  console.log("```");
  console.log(colorize("bold", "\ndocker-compose.yaml"));
  console.log("```yaml");
  console.log("services:");
  console.log("  app:");
  console.log("    volumes:");
  console.log(`      - ${USER_CODEX_HOME_DIR}:${USER_CODEX_HOME_DIR}`);
  console.log("    command: sh -lc 'pnpm install && npx codex-discord doctor && npx codex-discord start'");
  console.log("    environment:");
  console.log("      DISCORD_BOT_TOKEN: ${DISCORD_BOT_TOKEN}");
  console.log("      DISCORD_CHANNEL_ID: ${DISCORD_CHANNEL_ID}");
  console.log("```");
  console.log("");
}

function printDoctorNextActions(issues: DoctorIssue[]): void {
  if (issues.length === 0) {
    console.log(colorize("green", "\n[doctor] No blocking issues found"));
    return;
  }

  console.log(colorize("cyan", "\n[doctor] Next actions"));
  for (const [index, issue] of issues.entries()) {
    console.log(`${index + 1}. ${issue.message}`);
    console.log(`   ${issue.action}`);
  }
  console.log("");
}

function parseCliJsonOptions(args: string[]): CliJsonOptions {
  return {
    json: args.includes("--json"),
  };
}

function parseInitOptions(args: string[]): InitOptions {
  const options: InitOptions = {
    nonInteractive: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--non-interactive":
        options.nonInteractive = true;
        break;
      case "--token":
        options.token = args[index + 1] ?? "";
        index += 1;
        break;
      case "--channel":
        options.channelId = args[index + 1] ?? "";
        index += 1;
        break;
      case "--voice-channel":
        options.voiceChannelId = args[index + 1] ?? "";
        index += 1;
        break;
      case "--pre-prompt":
        options.prePrompt = args[index + 1] ?? "";
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

function parseMessagesOptions(args: string[]): MessagesOptions {
  let subcommand: MessagesOptions["subcommand"] = "list";
  let packName: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "list" || arg === "install") {
      subcommand = arg;
      if (arg === "install") {
        packName = args[index + 1];
        index += 1;
      }
      continue;
    }
  }

  return { subcommand, packName, json };
}

function getFilenameFromUrl(value: string): string {
  const url = new URL(value);
  return path.basename(url.pathname) || "asset.bin";
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function statusMark(ok: boolean): string {
  return ok ? colorize("green", "OK") : colorize("red", "MISSING");
}

function colorize(color: "red" | "green" | "yellow" | "cyan" | "bold", text: string): string {
  if (!process.stdout.isTTY) {
    return text;
  }

  const codes: Record<typeof color, string> = {
    red: "\u001B[31m",
    green: "\u001B[32m",
    yellow: "\u001B[33m",
    cyan: "\u001B[36m",
    bold: "\u001B[1m",
  };

  return `${codes[color]}${text}\u001B[0m`;
}

function logInfo(scope: string, message: string): void {
  console.log(`${colorize("cyan", `[${scope}]`)} ${message}`);
}

function logSuccess(scope: string, message: string): void {
  console.log(`${colorize("green", `[${scope}]`)} ${message}`);
}

function logWarn(scope: string, message: string): void {
  console.warn(`${colorize("yellow", `[${scope}] WARN`)} ${message}`);
}

function logError(scope: string, message: string): void {
  console.error(`${colorize("red", `[${scope}] ERROR`)} ${message}`);
}

void main().catch((error) => {
  logError("codex-discord", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
