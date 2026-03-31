import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScheduledTaskStore } from "../src/tasks/store.js";
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

describe("ScheduledTaskStore", () => {
  it("creates task directories with meta.json and memory.json", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-task-store-"));
    TEMP_DIRS.push(tempDir);

    const store = new ScheduledTaskStore(path.join(tempDir, "tasks"), new Logger("error"));
    await store.ensureStorage();
    const createdTask = await store.createTask({
      frequency: "2 hours",
      name: "Daily review",
      description: "Review recent changes and summarize risk.",
    });

    const savedMemory = await readFile(createdTask.memoryPath, "utf8");
    expect(savedMemory).toContain('"threads": {}');
    expect(savedMemory).toContain('"scheduledTask"');
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

  it("backfills silentTurns for an existing task memory file", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-task-store-"));
    TEMP_DIRS.push(tempDir);

    const store = new ScheduledTaskStore(path.join(tempDir, "tasks"), new Logger("error"));
    const taskDir = path.join(tempDir, "tasks", "task-guid");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      path.join(taskDir, "meta.json"),
      JSON.stringify(
        {
          name: "Task",
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

    const loadedTask = await store.readTask("task-guid");
    expect(loadedTask).not.toBeNull();

    const savedMemory = await readFile(path.join(taskDir, "memory.json"), "utf8");
    expect(savedMemory).toContain('"silentTurns": false');
  });
});
