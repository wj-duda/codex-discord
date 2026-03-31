import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { SessionMemory } from "../codex/sessionMemory.js";
import { Logger } from "../utils/logger.js";
import { parseScheduledChoreFrequency } from "./frequency.js";
import type { CreateScheduledChoreInput, ScheduledChoreDefinition, ScheduledChoreMeta } from "./types.js";

const META_FILE_NAME = "meta.json";
const MEMORY_FILE_NAME = "memory.json";
const DEFAULT_CHORE_MEMORY_OPTIONS = {
  scheduledChore: {
    silentTurns: false,
  },
} as const;

export class ScheduledChoreStore {
  constructor(
    private readonly choresRootDir: string,
    private readonly logger: Logger,
  ) {}

  async ensureStorage(): Promise<void> {
    await mkdir(this.choresRootDir, { recursive: true });
  }

  async createTask(input: CreateScheduledChoreInput): Promise<ScheduledChoreDefinition> {
    const name = input.name.trim();
    const description = input.description.trim();
    if (!name) {
      throw new Error("Chore name cannot be empty.");
    }
    if (!description) {
      throw new Error("Chore description cannot be empty.");
    }

    const parsedFrequency = parseScheduledChoreFrequency(input.frequency);
    const guid = randomUUID();
    const taskDir = path.join(this.choresRootDir, guid);
    const createdAt = new Date().toISOString();
    const meta: ScheduledChoreMeta = {
      name,
      description,
      frequency: parsedFrequency.normalized,
      createdAt,
      updatedAt: createdAt,
    };

    await mkdir(taskDir, { recursive: true });
    await writeFile(
      path.join(taskDir, MEMORY_FILE_NAME),
      SessionMemory.formatEmptyStore(DEFAULT_CHORE_MEMORY_OPTIONS),
      "utf8",
    );
    await this.writeJsonFile(path.join(taskDir, META_FILE_NAME), meta);

    return this.readTaskDefinition(guid, taskDir);
  }

  async deleteTask(guid: string): Promise<void> {
    await rm(path.join(this.choresRootDir, guid), { recursive: true, force: true });
  }

  async loadAllTasks(): Promise<ScheduledChoreDefinition[]> {
    await this.ensureStorage();

    const directoryEntries = await readdir(this.choresRootDir, { withFileTypes: true });
    const loadedTasks = await Promise.all(
      directoryEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.tryReadTaskDefinition(entry.name, path.join(this.choresRootDir, entry.name))),
    );

    return loadedTasks
      .filter((task): task is ScheduledChoreDefinition => Boolean(task))
      .sort((left, right) => left.meta.createdAt.localeCompare(right.meta.createdAt));
  }

  async readTask(guid: string): Promise<ScheduledChoreDefinition | null> {
    const taskDir = path.join(this.choresRootDir, guid);
    return this.tryReadTaskDefinition(guid, taskDir);
  }

  async saveTaskMeta(guid: string, meta: ScheduledChoreMeta): Promise<ScheduledChoreDefinition | null> {
    const taskDir = path.join(this.choresRootDir, guid);
    const currentTask = await this.readTask(guid);
    if (!currentTask) {
      return null;
    }

    const sanitizedMeta = normalizeTaskMeta({
      ...meta,
      updatedAt: new Date().toISOString(),
    });
    parseScheduledChoreFrequency(sanitizedMeta.frequency);

    await this.ensureTaskMemoryFile(taskDir);
    await this.writeJsonFile(path.join(taskDir, META_FILE_NAME), sanitizedMeta);
    return this.readTaskDefinition(guid, taskDir);
  }

  private async tryReadTaskDefinition(guid: string, taskDir: string): Promise<ScheduledChoreDefinition | null> {
    try {
      return await this.readTaskDefinition(guid, taskDir);
    } catch (error) {
      this.logger.warn(`Skipping invalid scheduled chore ${guid}`, error);
      return null;
    }
  }

  private async readTaskDefinition(guid: string, taskDir: string): Promise<ScheduledChoreDefinition> {
    const metaPath = path.join(taskDir, META_FILE_NAME);
    const memoryPath = path.join(taskDir, MEMORY_FILE_NAME);
    const metaRaw = await readFile(metaPath, "utf8");
    const metaParsed = normalizeTaskMeta(JSON.parse(metaRaw) as Partial<ScheduledChoreMeta>);
    const frequency = parseScheduledChoreFrequency(metaParsed.frequency);
    await this.ensureTaskMemoryFile(taskDir);
    const silentTurns = await this.readTaskSilentTurns(memoryPath);

    return {
      guid,
      dirPath: taskDir,
      metaPath,
      memoryPath,
      silentTurns,
      meta: metaParsed,
      frequency,
    };
  }

  private async ensureTaskMemoryFile(taskDir: string): Promise<void> {
    const memoryPath = path.join(taskDir, MEMORY_FILE_NAME);
    try {
      const rawMemory = await readFile(memoryPath, "utf8");
      const parsedMemory = JSON.parse(rawMemory) as {
        threads?: Record<string, unknown>;
        scheduledChore?: {
          silentTurns?: boolean;
        };
      };

      if (parsedMemory.scheduledChore?.silentTurns === undefined) {
        await this.writeJsonFile(memoryPath, {
          threads: parsedMemory.threads ?? {},
          scheduledChore: {
            silentTurns: false,
          },
        });
      }
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }

      await writeFile(memoryPath, SessionMemory.formatEmptyStore(DEFAULT_CHORE_MEMORY_OPTIONS), "utf8");
    }
  }

  private async writeJsonFile(targetPath: string, value: object): Promise<void> {
    await mkdir(path.dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tempPath, targetPath);
  }

  private async readTaskSilentTurns(memoryPath: string): Promise<boolean> {
    const memory = new SessionMemory(memoryPath);
    const settings = await memory.getScheduledChoreSettings();
    return settings.silentTurns;
  }
}

function normalizeTaskMeta(value: Partial<ScheduledChoreMeta>): ScheduledChoreMeta {
  const name = value.name?.trim();
  const description = value.description?.trim();
  const frequency = value.frequency?.trim();
  const createdAt = value.createdAt?.trim();

  if (!name) {
    throw new Error("Chore meta is missing a valid name.");
  }
  if (!description) {
    throw new Error("Chore meta is missing a valid description.");
  }
  if (!frequency) {
    throw new Error("Chore meta is missing a valid frequency.");
  }
  if (!createdAt || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error("Chore meta is missing a valid createdAt timestamp.");
  }

  return {
    name,
    description,
    frequency,
    createdAt,
    updatedAt: normalizeOptionalTimestamp(value.updatedAt),
    lastRunAt: normalizeOptionalTimestamp(value.lastRunAt),
    lastSuccessAt: normalizeOptionalTimestamp(value.lastSuccessAt),
    lastFailureAt: normalizeOptionalTimestamp(value.lastFailureAt),
    lastError: typeof value.lastError === "string" && value.lastError.trim() ? value.lastError.trim() : undefined,
  };
}

function normalizeOptionalTimestamp(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  return Number.isFinite(Date.parse(normalized)) ? normalized : undefined;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
