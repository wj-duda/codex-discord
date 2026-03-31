import { watch, type FSWatcher } from "node:fs";

import type { AppConfig } from "../config/env.js";
import { CodexSession } from "../codex/session.js";
import { Logger } from "../utils/logger.js";
import { computeScheduledTaskNextRunAt, isScheduledTaskDue } from "./frequency.js";
import { ScheduledTaskStore } from "./store.js";
import type { CreateScheduledTaskInput, ScheduledTaskDefinition, ScheduledTaskSummary } from "./types.js";

const TASK_RELOAD_DEBOUNCE_MS = 150;
const TASK_POLL_INTERVAL_MS = 15_000;

export interface ScheduledTaskRuntime {
  isReady(): boolean;
  runScheduledTask(task: ScheduledTaskDefinition, session: CodexSession): Promise<void>;
}

export class ScheduledTaskManager {
  private readonly store: ScheduledTaskStore;
  private readonly tasks = new Map<string, ScheduledTaskDefinition>();
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
    private readonly runtime: ScheduledTaskRuntime,
  ) {
    this.store = new ScheduledTaskStore(config.tasksRootPath, logger);
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

  async createTask(input: CreateScheduledTaskInput): Promise<ScheduledTaskDefinition> {
    const createdTask = await this.store.createTask(input);
    await this.reloadTasks(`create:${createdTask.guid}`);
    return this.tasks.get(createdTask.guid) ?? createdTask;
  }

  async runTaskNow(guid: string): Promise<{ status: "started" | "already_running"; task: ScheduledTaskDefinition } | null> {
    let task = this.tasks.get(guid) ?? null;
    if (!task) {
      task = await this.store.readTask(guid);
      if (!task) {
        return null;
      }
      this.tasks.set(task.guid, task);
    }

    if (!this.runtime.isReady()) {
      throw new Error("The bridge is not ready yet.");
    }

    if (this.activeTaskGuid === guid) {
      return { status: "already_running", task };
    }

    if (this.activeTaskGuid) {
      throw new Error("Another scheduled task is already running.");
    }

    this.activeTaskGuid = guid;
    void this.executeTask(task);
    return { status: "started", task };
  }

  listTasks(): ScheduledTaskSummary[] {
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
        nextRunAt: computeScheduledTaskNextRunAt(task).toISOString(),
      }));
  }

  async deleteTask(guid: string): Promise<ScheduledTaskDefinition | null> {
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
    this.rootWatcher = watch(this.config.tasksRootPath, () => {
      this.scheduleReload("root");
    });

    for (const task of this.tasks.values()) {
      this.ensureTaskWatcher(task);
    }
  }

  private startPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    this.pollTimer = setInterval(() => {
      void this.drainDueTasks();
    }, TASK_POLL_INTERVAL_MS);
  }

  private scheduleReload(reason: string): void {
    if (this.shuttingDown) {
      return;
    }

    this.clearReloadTimer();
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      void this.reloadTasks(reason);
    }, TASK_RELOAD_DEBOUNCE_MS);
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
      this.ensureTaskWatcher(task);
    }

    for (const [guid, watcher] of this.taskWatchers) {
      if (!this.tasks.has(guid)) {
        watcher.close();
        this.taskWatchers.delete(guid);
      }
    }

    this.logger.info(`Reloaded scheduled tasks`, {
      reason,
      count: this.tasks.size,
    });
  }

  private ensureTaskWatcher(task: ScheduledTaskDefinition): void {
    if (this.taskWatchers.has(task.guid)) {
      return;
    }

    const watcher = watch(task.dirPath, () => {
      this.scheduleReload(`task:${task.guid}`);
    });
    this.taskWatchers.set(task.guid, watcher);
  }

  private async drainDueTasks(): Promise<void> {
    if (this.shuttingDown || !this.runtime.isReady() || this.activeTaskGuid) {
      return;
    }

    const dueTask = [...this.tasks.values()]
      .filter((task) => isScheduledTaskDue(task))
      .sort((left, right) => computeScheduledTaskNextRunAt(left).getTime() - computeScheduledTaskNextRunAt(right).getTime())
      .at(0);

    if (!dueTask) {
      return;
    }

    this.activeTaskGuid = dueTask.guid;
    await this.executeTask(dueTask);
  }

  private async persistTaskMeta(guid: string, meta: ScheduledTaskDefinition["meta"]): Promise<ScheduledTaskDefinition | null> {
    const savedTask = await this.store.saveTaskMeta(guid, meta);
    if (savedTask) {
      this.tasks.set(guid, savedTask);
    }
    return savedTask;
  }

  private getOrCreateSession(task: ScheduledTaskDefinition): CodexSession {
    const existing = this.sessions.get(task.guid);
    if (existing) {
      return existing;
    }

    const session = new CodexSession(
      {
        ...this.config,
        discordChannelId: `scheduled-task:${task.guid}`,
        codexThreadMapPath: task.memoryPath,
      },
      this.logger,
    );
    this.sessions.set(task.guid, session);
    return session;
  }

  private async executeTask(dueTask: ScheduledTaskDefinition): Promise<void> {
    let startedAt: string | null = null;
    let taskAtStart = dueTask;
    try {
      startedAt = new Date().toISOString();
      taskAtStart =
        (await this.persistTaskMeta(dueTask.guid, {
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
      await this.runtime.runScheduledTask(taskAtStart, session);
      await this.persistTaskMeta(taskAtStart.guid, {
        ...taskAtStart.meta,
        lastRunAt: startedAt,
        lastSuccessAt: new Date().toISOString(),
        lastError: undefined,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Scheduled task ${dueTask.guid} failed`, error);
      await this.persistTaskMeta(taskAtStart.guid, {
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
