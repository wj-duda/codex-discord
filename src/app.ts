import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { stat, utimes } from "node:fs/promises";
import path from "node:path";

import { getMissingRequiredEnvVars, loadConfig } from "./config/env.js";
import { CodexSession } from "./codex/session.js";
import { DiscordBridgeBot } from "./discord/bot.js";
import { ensureModelAssets } from "./runtime/modelAssets.js";
import { ScheduledTaskManager } from "./tasks/manager.js";
import { Logger } from "./utils/logger.js";

export async function runBridge(): Promise<void> {
  const missingEnvVars = getMissingRequiredEnvVars();
  if (missingEnvVars.length > 0) {
    console.error("Missing required environment variables:");
    for (const name of missingEnvVars) {
      console.error(`- ${name}`);
    }
    process.exit(1);
  }

  const baseConfig = loadConfig();
  const logger = new Logger(baseConfig.logLevel);
  const config = await ensureModelAssets(baseConfig, logger);
  const session = new CodexSession(config, logger);
  let taskManager: ScheduledTaskManager | null = null;
  const bot = new DiscordBridgeBot(
    config,
    {
      isCodexBusy: () => session.hasActiveTurns(),
      onUserMessage: async (input, context, stream, mode) => {
        logger.info(`Forwarding ${context.source} ${context.requestId} to Codex`, { mode });
        return session.sendUserMessage(input, stream, mode);
      },
      onRestartRequested: async (context) => {
        logger.info(`Restart requested from ${context.source} ${context.requestId}`);
        await restart();
      },
      onCreateScheduledTask: async (input) => {
        if (!taskManager) {
          throw new Error("Scheduled task manager is not ready yet.");
        }

        return taskManager.createTask(input);
      },
      onListScheduledTasks: async () => {
        if (!taskManager) {
          throw new Error("Scheduled task manager is not ready yet.");
        }

        return taskManager.listTasks();
      },
      onDeleteScheduledTask: async (guid) => {
        if (!taskManager) {
          throw new Error("Scheduled task manager is not ready yet.");
        }

        return taskManager.deleteTask(guid);
      },
      onRunScheduledTask: async (guid) => {
        if (!taskManager) {
          throw new Error("Scheduled task manager is not ready yet.");
        }

        return taskManager.runTaskNow(guid);
      },
    },
    logger,
  );
  taskManager = new ScheduledTaskManager(config, logger, bot);
  let lifecycleInProgress = false;
  const isWatchedRuntime = process.argv.some((arg) => arg === "watch");
  let messagesReloadTimer: NodeJS.Timeout | null = null;
  const messagesWatcher = watch(baseConfig.messagesConfigPath, () => {
    if (messagesReloadTimer) {
      clearTimeout(messagesReloadTimer);
    }

    messagesReloadTimer = setTimeout(() => {
      messagesReloadTimer = null;
      void reloadMessagesConfig();
    }, 150);
  });

  const reloadMessagesConfig = async (): Promise<void> => {
    try {
      const nextBaseConfig = loadConfig();
      const nextConfig = await ensureModelAssets(nextBaseConfig, logger);
      bot.reloadMessageConfig({
        discordStartupSfx: nextConfig.discordStartupSfx,
        discordShutdownSfx: nextConfig.discordShutdownSfx,
        discordWorkingSfx: nextConfig.discordWorkingSfx,
        discordStartupMessages: nextConfig.discordStartupMessages,
        discordShutdownMessages: nextConfig.discordShutdownMessages,
        discordVoiceListeningMessages: nextConfig.discordVoiceListeningMessages,
        discordVoiceCapturedMessages: nextConfig.discordVoiceCapturedMessages,
        discordVoiceProcessingMessages: nextConfig.discordVoiceProcessingMessages,
        discordVoiceRejectedMessages: nextConfig.discordVoiceRejectedMessages,
        discordVoiceStoppedMessages: nextConfig.discordVoiceStoppedMessages,
        discordScheduledTaskStartMessages: nextConfig.discordScheduledTaskStartMessages,
        discordCodexWorkingMessages: nextConfig.discordCodexWorkingMessages,
        discordCodexStartMessages: nextConfig.discordCodexStartMessages,
        discordCodexReasoningMessages: nextConfig.discordCodexReasoningMessages,
        discordCodexToolMessages: nextConfig.discordCodexToolMessages,
        discordCodexPlanMessages: nextConfig.discordCodexPlanMessages,
      });
      logger.info(`Reloaded messages config from ${nextBaseConfig.messagesConfigPath}`);
    } catch (error) {
      logger.warn("Failed to hot reload messages config", error);
    }
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (lifecycleInProgress) {
      logger.info(`Ignoring duplicate ${signal} during shutdown`);
      return;
    }

    lifecycleInProgress = true;
    logger.info(`Received ${signal}, shutting down`);
    messagesWatcher.close();
    if (messagesReloadTimer) {
      clearTimeout(messagesReloadTimer);
      messagesReloadTimer = null;
    }
    bot.beginShutdown();
    bot.prepareShutdownAnnouncement();
    await taskManager?.shutdown();
    await Promise.allSettled([session.shutdown(), bot.stop({ announceText: true })]);
    process.exit(0);
  };

  const restart = async (): Promise<void> => {
    if (lifecycleInProgress) {
      logger.info("Ignoring duplicate restart during lifecycle transition");
      return;
    }

    lifecycleInProgress = true;
    if (isWatchedRuntime) {
      logger.info("Restart requested under watch runtime, touching src/index.ts for watcher restart");
      const restartTarget = path.join(process.cwd(), "src/index.ts");
      const now = new Date();
      const existing = await stat(restartTarget);
      await utimes(restartTarget, now, now > existing.mtime ? now : new Date(existing.mtime.getTime() + 1000));
      return;
    } else {
      logger.info("Spawning replacement bridge process");
      const child = spawn(process.execPath, process.argv.slice(1), {
        cwd: process.cwd(),
        env: process.env,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }

    bot.beginShutdown();
    bot.prepareShutdownAnnouncement();
    await taskManager?.shutdown();
    await Promise.allSettled([session.shutdown(), bot.stop({ announceText: true })]);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await session.initialize();
  await taskManager.initialize();
  await bot.start();
}
