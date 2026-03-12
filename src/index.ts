import { getMissingRequiredEnvVars, loadConfig } from "./config/env.js";
import { CodexSession } from "./codex/session.js";
import { DiscordBridgeBot } from "./discord/bot.js";
import { Logger } from "./utils/logger.js";

async function main(): Promise<void> {
  const missingEnvVars = getMissingRequiredEnvVars();
  if (missingEnvVars.length > 0) {
    console.error("Missing required environment variables:");
    for (const name of missingEnvVars) {
      console.error(`- ${name}`);
    }
    process.exit(1);
  }

  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  const session = new CodexSession(config, logger);
  const bot = new DiscordBridgeBot(
    config,
    {
      onUserMessage: async (input, message, stream) => {
        logger.info(`Forwarding message ${message.id} to Codex`);
        return session.sendUserMessage(input, stream);
      },
    },
    logger,
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    bot.beginShutdown();
    if (config.discordShutdownMessage) {
      await Promise.allSettled([bot.announce(config.discordShutdownMessage)]);
    }
    await Promise.allSettled([session.shutdown(), bot.stop()]);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  await session.initialize();
  await bot.start();
}

process.on("unhandledRejection", (reason) => {
  console.error("[process] Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[process] Uncaught exception", error);
});

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
