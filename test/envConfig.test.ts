import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildDefaultMessagesConfig,
  isAnyVoiceFeatureEnabled,
  isVoiceChannelTransportEnabled,
  loadConfig,
} from "../src/config/env.js";

const ORIGINAL_ENV = { ...process.env };
const TEMP_DIRS: string[] = [];

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };

  while (TEMP_DIRS.length > 0) {
    const tempDir = TEMP_DIRS.pop();
    if (!tempDir) {
      continue;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("loadConfig voice flags", () => {
  it("defaults to text-only mode when no voice flags are set", async () => {
    await prepareEnv();

    delete process.env.DISCORD_VOICE_ENABLED;
    delete process.env.DISCORD_VOICE_INPUT_ENABLED;
    delete process.env.DISCORD_VOICE_OUTPUT_ENABLED;
    delete process.env.DISCORD_VOICE_CHANNEL_ID;

    const config = loadConfig();

    expect(config.discordVoiceEnabled).toBe(false);
    expect(config.discordVoiceInputEnabled).toBe(false);
    expect(config.discordVoiceOutputEnabled).toBe(false);
  });

  it("auto-enables voice when a voice channel is configured and flags are unset", async () => {
    await prepareEnv();

    process.env.DISCORD_VOICE_CHANNEL_ID = "voice-channel";
    delete process.env.DISCORD_VOICE_ENABLED;
    delete process.env.DISCORD_VOICE_INPUT_ENABLED;
    delete process.env.DISCORD_VOICE_OUTPUT_ENABLED;

    const config = loadConfig();

    expect(config.discordVoiceEnabled).toBe(true);
    expect(config.discordVoiceInputEnabled).toBe(true);
    expect(config.discordVoiceOutputEnabled).toBe(true);
  });

  it("lets an explicit false disable auto-discovery even when a voice channel is configured", async () => {
    await prepareEnv();

    process.env.DISCORD_VOICE_CHANNEL_ID = "voice-channel";
    process.env.DISCORD_VOICE_ENABLED = "false";
    delete process.env.DISCORD_VOICE_INPUT_ENABLED;
    delete process.env.DISCORD_VOICE_OUTPUT_ENABLED;

    const config = loadConfig();

    expect(config.discordVoiceEnabled).toBe(false);
    expect(config.discordVoiceInputEnabled).toBe(false);
    expect(config.discordVoiceOutputEnabled).toBe(false);
    expect(isAnyVoiceFeatureEnabled(config)).toBe(false);
    expect(isVoiceChannelTransportEnabled(config)).toBe(false);
  });

  it("uses DISCORD_VOICE_ENABLED as the base switch and still allows overrides", async () => {
    await prepareEnv();

    process.env.DISCORD_VOICE_ENABLED = "true";
    process.env.DISCORD_VOICE_INPUT_ENABLED = "false";

    const config = loadConfig();

    expect(config.discordVoiceEnabled).toBe(true);
    expect(config.discordVoiceInputEnabled).toBe(false);
    expect(config.discordVoiceOutputEnabled).toBe(true);
  });

  it("supports input-only mode without a voice channel", async () => {
    await prepareEnv();

    process.env.DISCORD_VOICE_ENABLED = "false";
    process.env.DISCORD_VOICE_INPUT_ENABLED = "true";
    delete process.env.DISCORD_VOICE_OUTPUT_ENABLED;
    delete process.env.DISCORD_VOICE_CHANNEL_ID;

    const config = loadConfig();

    expect(config.discordVoiceEnabled).toBe(false);
    expect(config.discordVoiceInputEnabled).toBe(true);
    expect(config.discordVoiceOutputEnabled).toBe(false);
    expect(isAnyVoiceFeatureEnabled(config)).toBe(true);
    expect(isVoiceChannelTransportEnabled(config)).toBe(false);
  });

  it("supports output-only mode when a voice channel is configured", async () => {
    await prepareEnv();

    process.env.DISCORD_VOICE_ENABLED = "false";
    process.env.DISCORD_VOICE_OUTPUT_ENABLED = "true";
    delete process.env.DISCORD_VOICE_INPUT_ENABLED;
    process.env.DISCORD_VOICE_CHANNEL_ID = "voice-channel";

    const config = loadConfig();

    expect(config.discordVoiceEnabled).toBe(false);
    expect(config.discordVoiceInputEnabled).toBe(false);
    expect(config.discordVoiceOutputEnabled).toBe(true);
    expect(isAnyVoiceFeatureEnabled(config)).toBe(true);
    expect(isVoiceChannelTransportEnabled(config)).toBe(true);
  });
});

async function prepareEnv(): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-config-test-"));
  TEMP_DIRS.push(tempDir);

  const messagesPath = path.join(tempDir, "messages.json");
  await writeFile(messagesPath, `${JSON.stringify(buildDefaultMessagesConfig(), null, 2)}\n`, "utf8");

  process.env.DISCORD_BOT_TOKEN = "token";
  process.env.DISCORD_CHANNEL_ID = "channel";
  process.env.DISCORD_MESSAGES_PATH = messagesPath;
  process.env.CODEX_THREAD_MAP_PATH = path.join(tempDir, "memory.json");
}
