import { appendFileSync } from "node:fs";
import path from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEBUG_LOG_PATH = path.join(process.cwd(), "debug.log");
const ERROR_LOG_PATH = path.join(process.cwd(), "error.log");

export class Logger {
  constructor(private readonly level: LogLevel) {}

  debug(message: string, meta?: unknown): void {
    this.log("debug", message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.log("info", message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.log("warn", message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.log("error", message, meta);
  }

  private log(level: LogLevel, message: string, meta?: unknown): void {
    if (priorities[level] < priorities[this.level]) {
      return;
    }

    const prefix = `[${new Date().toISOString()}] ${level.toUpperCase()}`;
    const line = meta === undefined ? `${prefix} ${message}` : `${prefix} ${message} ${formatMeta(meta)}`;

    console.log(line);
    appendLine(DEBUG_LOG_PATH, line);
    if (level === "error") {
      appendLine(ERROR_LOG_PATH, line);
    }
  }
}

function appendLine(filePath: string, line: string): void {
  appendFileSync(filePath, `${line}\n`, "utf8");
}

function formatMeta(meta: unknown): string {
  if (meta instanceof Error) {
    return meta.stack || meta.message;
  }

  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}
