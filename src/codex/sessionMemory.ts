import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface StoredSessionRecord {
  codexThreadId: string;
  lastProcessedDiscordMessageId?: string;
  updatedAt: string;
}

export interface ScheduledTaskMemorySettings {
  silentTurns?: boolean;
}

interface SessionMemoryStoreShape {
  threads: Record<string, StoredSessionRecord>;
  scheduledTask?: ScheduledTaskMemorySettings;
}

const EMPTY_SESSION_MEMORY_STORE: SessionMemoryStoreShape = {
  threads: {},
};

export class SessionMemory {
  constructor(private readonly filePath: string) {}

  async get(sessionId: string): Promise<StoredSessionRecord | null> {
    const store = await this.readStore();
    return store.threads[sessionId] ?? null;
  }

  async set(sessionId: string, codexThreadId: string): Promise<void> {
    const store = await this.readStore();
    const existing = store.threads[sessionId];
    store.threads[sessionId] = {
      codexThreadId,
      lastProcessedDiscordMessageId: existing?.lastProcessedDiscordMessageId,
      updatedAt: new Date().toISOString(),
    };
    await this.writeStore(store);
  }

  async setLastProcessedDiscordMessageId(sessionId: string, lastProcessedDiscordMessageId: string): Promise<void> {
    const store = await this.readStore();
    const existing = store.threads[sessionId];
    if (!existing?.codexThreadId) {
      return;
    }

    store.threads[sessionId] = {
      codexThreadId: existing.codexThreadId,
      lastProcessedDiscordMessageId,
      updatedAt: new Date().toISOString(),
    };
    await this.writeStore(store);
  }

  async getScheduledTaskSettings(): Promise<Required<ScheduledTaskMemorySettings>> {
    const store = await this.readStore();
    return {
      silentTurns: store.scheduledTask?.silentTurns === true,
    };
  }

  static formatEmptyStore(options?: { scheduledTask?: ScheduledTaskMemorySettings }): string {
    const store: SessionMemoryStoreShape = {
      threads: {},
      ...(options?.scheduledTask
        ? {
            scheduledTask: {
              silentTurns: options.scheduledTask.silentTurns === true,
            },
          }
        : {}),
    };
    return `${JSON.stringify(store, null, 2)}\n`;
  }

  private async readStore(): Promise<SessionMemoryStoreShape> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionMemoryStoreShape>;
      return {
        threads: parsed.threads ?? {},
        scheduledTask:
          typeof parsed.scheduledTask === "object" && parsed.scheduledTask !== null
            ? {
                silentTurns: parsed.scheduledTask.silentTurns === true,
              }
            : undefined,
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return { ...EMPTY_SESSION_MEMORY_STORE, threads: {} };
      }

      throw error;
    }
  }

  private async writeStore(store: SessionMemoryStoreShape): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
