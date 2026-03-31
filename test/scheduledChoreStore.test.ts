import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScheduledChoreStore } from "../src/chores/store.js";
import { Logger } from "../src/utils/logger.js";

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

describe("ScheduledChoreStore", () => {
  it("creates chore directories with meta.json and memory.json", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-chore-store-"));
    TEMP_DIRS.push(tempDir);

    const store = new ScheduledChoreStore(path.join(tempDir, "chores"), new Logger("error"));
    await store.ensureStorage();
    const createdTask = await store.createTask({
      frequency: "2 hours",
      name: "Daily review",
      description: "Review recent changes and summarize risk.",
    });

    const savedMemory = await readFile(createdTask.memoryPath, "utf8");
    expect(savedMemory).toContain('"threads": {}');
    expect(savedMemory).toContain('"scheduledChore"');
    expect(savedMemory).toContain('"silentTurns": false');

    const loadedTasks = await store.loadAllTasks();
    expect(loadedTasks).toHaveLength(1);
    expect(loadedTasks[0]).toMatchObject({
      guid: createdTask.guid,
      meta: {
        name: "Daily review",
        description: "Review recent changes and summarize risk.",
        frequency: "2hours",
      },
    });
  });

  it("backfills silentTurns for an existing chore memory file", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-chore-store-"));
    TEMP_DIRS.push(tempDir);

    const store = new ScheduledChoreStore(path.join(tempDir, "chores"), new Logger("error"));
    const taskDir = path.join(tempDir, "chores", "chore-guid");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      path.join(taskDir, "meta.json"),
      JSON.stringify(
        {
          name: "Chore",
          description: "Description",
          frequency: "1hour",
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(taskDir, "memory.json"),
      JSON.stringify(
        {
          threads: {},
        },
        null,
        2,
      ),
    );

    const loadedTask = await store.readTask("chore-guid");
    expect(loadedTask).not.toBeNull();

    const savedMemory = await readFile(path.join(taskDir, "memory.json"), "utf8");
    expect(savedMemory).toContain('"silentTurns": false');
  });
});
