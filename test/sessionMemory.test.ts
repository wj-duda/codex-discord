import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionMemory } from "../src/codex/sessionMemory.js";

const TEMP_DIRS: string[] = [];

afterEach(async () => {
  while (TEMP_DIRS.length > 0) {
    const tempDir = TEMP_DIRS.pop();
    if (!tempDir) {
      continue;
    }

    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("SessionMemory", () => {
  it("persists thread ids and Discord checkpoints in the shared memory format", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-session-memory-"));
    TEMP_DIRS.push(tempDir);

    const memory = new SessionMemory(path.join(tempDir, "memory.json"));
    await memory.set("main", "thread-123");
    await memory.setLastProcessedDiscordMessageId("main", "message-456");

    await expect(memory.get("main")).resolves.toEqual({
      codexThreadId: "thread-123",
      lastProcessedDiscordMessageId: "message-456",
      updatedAt: expect.any(String),
    });
  });

  it("reads scheduled chore settings and defaults silentTurns to false", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-session-memory-"));
    TEMP_DIRS.push(tempDir);

    const memory = new SessionMemory(path.join(tempDir, "memory.json"));
    await expect(memory.getScheduledChoreSettings()).resolves.toEqual({
      silentTurns: false,
    });
  });
});
