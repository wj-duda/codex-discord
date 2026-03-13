import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface StoredThreadRecord {
  codexThreadId: string;
  lastProcessedDiscordMessageId?: string;
  updatedAt: string;
}

interface StoreShape {
  threads: Record<string, StoredThreadRecord>;
}

const EMPTY_STORE: StoreShape = {
  threads: {},
};

export class CodexThreadStore {
  constructor(private readonly filePath: string) {}

  async get(discordConversationId: string): Promise<StoredThreadRecord | null> {
    const store = await this.readStore();
    return store.threads[discordConversationId] ?? null;
  }

  async set(discordConversationId: string, codexThreadId: string): Promise<void> {
    const store = await this.readStore();
    const existing = store.threads[discordConversationId];
    store.threads[discordConversationId] = {
      codexThreadId,
      lastProcessedDiscordMessageId: existing?.lastProcessedDiscordMessageId,
      updatedAt: new Date().toISOString(),
    };
    await this.writeStore(store);
  }

  async setLastProcessedDiscordMessageId(
    discordConversationId: string,
    lastProcessedDiscordMessageId: string,
  ): Promise<void> {
    const store = await this.readStore();
    const existing = store.threads[discordConversationId];
    if (!existing?.codexThreadId) {
      return;
    }

    store.threads[discordConversationId] = {
      codexThreadId: existing.codexThreadId,
      lastProcessedDiscordMessageId,
      updatedAt: new Date().toISOString(),
    };
    await this.writeStore(store);
  }

  private async readStore(): Promise<StoreShape> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreShape>;
      return {
        threads: parsed.threads ?? {},
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return { ...EMPTY_STORE, threads: {} };
      }

      throw error;
    }
  }

  private async writeStore(store: StoreShape): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
