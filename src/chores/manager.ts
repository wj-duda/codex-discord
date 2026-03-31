import { watch, type FSWatcher } from "node:fs";

import type { AppConfig } from "../config/env.js";
import { CodexSession } from "../codex/session.js";
import { Logger } from "../utils/logger.js";
import { computeScheduledChoreNextRunAt, isScheduledChoreDue } from "./frequency.js";
import { ScheduledChoreStore } from "./store.js";
import type { CreateScheduledChoreInput, ScheduledChoreDefinition, ScheduledChoreSummary } from "./types.js";

const CHORE_RELOAD_DEBOUNCE_MS = 150;
const CHORE_POLL_INTERVAL_MS = 15_000;

export interface ScheduledChoreRuntime {
  isReady(): boolean;
  runScheduledChore(chore: ScheduledChoreDefinition, session: CodexSession): Promise<void>;
}

export class ScheduledChoreManager {
  private readonly store: ScheduledChoreStore;
  private readonly tasks = new Map<string, ScheduledChoreDefinition>();
  private readonly sessions = new Map<string, CodexSession>();
  private readonly taskWatchers = new Map<string, FSWatcher>();
  private rootWatcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private activeTaskGuid: string | null = null;
  private shuttingDown = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly runtime: ScheduledChoreRuntime,
  ) {
    this.store = new ScheduledChoreStore(config.choresRootPath, logger);
  }

  async initialize(): Promise<void> {
    await this.store.ensureStorage();
    await this.reloadTasks("startup");
    this.startWatchers();
    this.startPolling();
    void this.drainDueTasks();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.clearReloadTimer();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.rootWatcher?.close();
    this.rootWatcher = null;
    for (const watcher of this.taskWatchers.values()) {
      watcher.close();
    }
    this.taskWatchers.clear();

    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.shutdown()));
  }

  async createTask(input: CreateScheduledChoreInput): Promise<ScheduledChoreDefinition> {
    const createdTask = await this.store.createTask(input);
    await this.reloadTasks(`create:${createdTask.guid}`);
    return this.tasks.get(createdTask.guid) ?? createdTask;
  }

  async runChoreNow(guid: string): Promise<{ status: "started" | "already_running"; chore: ScheduledChoreDefinition } | null> {
    let chore = this.tasks.get(guid) ?? null;
    if (!chore) {
      chore = await this.store.readTask(guid);
      if (!chore) {
        return null;
      }
      this.tasks.set(chore.guid, chore);
    }

    if (!this.runtime.isReady()) {
      throw new Error("The bridge is not ready yet.");
    }

    if (this.activeTaskGuid === guid) {
      return { status: "already_running", chore };
    }

    if (this.activeTaskGuid) {
      throw new Error("Another scheduled chore is already running.");
    }

    this.activeTaskGuid = guid;
    void this.executeChore(chore);
    return { status: "started", chore };
  }

  listTasks(): ScheduledChoreSummary[] {
    return [...this.tasks.values()]
      .sort((left, right) => {
        const intervalDifference = left.frequency.intervalMs - right.frequency.intervalMs;
        if (intervalDifference !== 0) {
          return intervalDifference;
        }

        return left.meta.name.localeCompare(right.meta.name);
      })
      .map((task) => ({
        guid: task.guid,
        name: task.meta.name,
        descriptionPreview: summarizeTaskDescription(task.meta.description),
        frequency: task.meta.frequency,
        silentTurns: task.silentTurns,
        intervalMs: task.frequency.intervalMs,
        createdAt: task.meta.createdAt,
        lastRunAt: task.meta.lastRunAt ?? null,
        nextRunAt: computeScheduledChoreNextRunAt(task).toISOString(),
      }));
  }

  async deleteTask(guid: string): Promise<ScheduledChoreDefinition | null> {
    let existingTask = this.tasks.get(guid) ?? null;
    if (!existingTask) {
      const taskFromDisk = await this.store.readTask(guid);
      if (!taskFromDisk) {
        return null;
      }
      existingTask = taskFromDisk;
    }

    await this.disposeTaskRuntime(guid);
    await this.store.deleteTask(guid);
    await this.reloadTasks(`delete:${guid}`);
    return existingTask;
  }

  private startWatchers(): void {
    this.rootWatcher?.close();
    this.rootWatcher = watch(this.config.choresRootPath, () => {
      this.scheduleReload("root");
    });

    for (const task of this.tasks.values()) {
      this.ensureChoreWatcher(task);
    }
  }

  private startPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    this.pollTimer = setInterval(() => {
      void this.drainDueTasks();
    }, CHORE_POLL_INTERVAL_MS);
  }

  private scheduleReload(reason: string): void {
    if (this.shuttingDown) {
      return;
    }

    this.clearReloadTimer();
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      void this.reloadTasks(reason);
    }, CHORE_RELOAD_DEBOUNCE_MS);
  }

  private clearReloadTimer(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  private async reloadTasks(reason: string): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    const loadedTasks = await this.store.loadAllTasks();
    const nextTasks = new Map(loadedTasks.map((task) => [task.guid, task]));

    for (const guid of this.tasks.keys()) {
      if (!nextTasks.has(guid)) {
        await this.disposeTaskRuntime(guid);
      }
    }

    this.tasks.clear();
    for (const task of loadedTasks) {
      this.tasks.set(task.guid, task);
      this.ensureChoreWatcher(task);
    }

    for (const [guid, watcher] of this.taskWatchers) {
      if (!this.tasks.has(guid)) {
        watcher.close();
        this.taskWatchers.delete(guid);
      }
    }

    this.logger.info(`Reloaded scheduled chores`, {
      reason,
      count: this.tasks.size,
    });
  }

  private ensureChoreWatcher(task: ScheduledChoreDefinition): void {
    if (this.taskWatchers.has(task.guid)) {
      return;
    }

    const watcher = watch(task.dirPath, () => {
      this.scheduleReload(`chore:${task.guid}`);
    });
    this.taskWatchers.set(task.guid, watcher);
  }

  private async drainDueTasks(): Promise<void> {
    if (this.shuttingDown || !this.runtime.isReady() || this.activeTaskGuid) {
      return;
    }

    const dueTask = [...this.tasks.values()]
      .filter((task) => isScheduledChoreDue(task))
      .sort((left, right) => computeScheduledChoreNextRunAt(left).getTime() - computeScheduledChoreNextRunAt(right).getTime())
      .at(0);

    if (!dueTask) {
      return;
    }

    this.activeTaskGuid = dueTask.guid;
      await this.executeChore(dueTask);
  }

  private async persistChoreMeta(guid: string, meta: ScheduledChoreDefinition["meta"]): Promise<ScheduledChoreDefinition | null> {
    const savedTask = await this.store.saveTaskMeta(guid, meta);
    if (savedTask) {
      this.tasks.set(guid, savedTask);
    }
    return savedTask;
  }

  private getOrCreateSession(chore: ScheduledChoreDefinition): CodexSession {
    const existing = this.sessions.get(chore.guid);
    if (existing) {
      return existing;
    }

    const session = new CodexSession(
      {
        ...this.config,
        discordChannelId: `scheduled-chore:${chore.guid}`,
        codexThreadMapPath: chore.memoryPath,
      },
      this.logger,
    );
    this.sessions.set(chore.guid, session);
    return session;
  }

  private async executeChore(dueTask: ScheduledChoreDefinition): Promise<void> {
    let startedAt: string | null = null;
    let taskAtStart = dueTask;
    try {
      startedAt = new Date().toISOString();
      taskAtStart =
        (await this.persistChoreMeta(dueTask.guid, {
          ...dueTask.meta,
          lastRunAt: startedAt,
          lastError: undefined,
        })) ??
        {
          ...dueTask,
          meta: {
            ...dueTask.meta,
            lastRunAt: startedAt,
            lastError: undefined,
          },
        };

      const session = this.getOrCreateSession(taskAtStart);
      await this.runtime.runScheduledChore(taskAtStart, session);
      await this.persistChoreMeta(taskAtStart.guid, {
        ...taskAtStart.meta,
        lastRunAt: startedAt,
        lastSuccessAt: new Date().toISOString(),
        lastError: undefined,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Scheduled chore ${dueTask.guid} failed`, error);
      await this.persistChoreMeta(taskAtStart.guid, {
        ...taskAtStart.meta,
        lastRunAt: startedAt ?? taskAtStart.meta.lastRunAt,
        lastFailureAt: new Date().toISOString(),
        lastError: errorMessage,
      }).catch(() => undefined);
    } finally {
      if (this.activeTaskGuid === dueTask.guid) {
        this.activeTaskGuid = null;
      }
      void this.drainDueTasks();
    }
  }

  private async disposeTaskRuntime(guid: string): Promise<void> {
    const watcher = this.taskWatchers.get(guid);
    if (watcher) {
      watcher.close();
      this.taskWatchers.delete(guid);
    }

    const session = this.sessions.get(guid);
    if (session) {
      this.sessions.delete(guid);
      await session.shutdown().catch(() => undefined);
    }

    if (this.activeTaskGuid === guid) {
      this.activeTaskGuid = null;
    }
  }
}

function summarizeTaskDescription(description: string): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  const sentenceMatch = normalized.match(/^(.+?[.!?])(?:\s|$)/);
  if (sentenceMatch?.[1]) {
    return sentenceMatch[1];
  }

  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
}
