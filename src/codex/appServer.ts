import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JsonRpcClient } from "./jsonRpcClient.js";
import { Logger } from "../utils/logger.js";

const USER_CODEX_HOME_DIR = path.join(os.homedir(), ".codex");
export class CodexAppServer {
  private static readonly SHUTDOWN_TIMEOUT_MS = 3_000;
  private process: ChildProcessWithoutNullStreams | null = null;
  private client: JsonRpcClient | null = null;
  private readonly projectCodexHomeDir: string;

  constructor(
    private readonly logger: Logger,
    codexCwd?: string,
  ) {
    const resolvedCodexCwd =
      typeof codexCwd === "string" && codexCwd.trim().length > 0
        ? codexCwd
        : process.cwd();

    if (resolvedCodexCwd !== codexCwd) {
      this.logger.warn("Codex app-server started without a valid CODEX_CWD, falling back to process.cwd()", {
        codexCwd,
        fallback: resolvedCodexCwd,
      });
    }

    this.projectCodexHomeDir = path.resolve(resolvedCodexCwd, ".codex");
  }

  async start(): Promise<JsonRpcClient> {
    if (this.client) {
      return this.client;
    }

    const childEnv = await this.getChildEnvironment();
    const child = spawn(this.getCodexExecutable(), ["app-server"], {
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        this.logger.debug("codex app-server stderr", text);
      }
    });

    child.on("exit", (code, signal) => {
      if (code === 0 && signal === null) {
        this.logger.info(`codex app-server exited`, { code, signal });
      } else {
        this.logger.error(`codex app-server exited`, { code, signal });
      }
      this.client?.dispose();
      this.client = null;
      this.process = null;
    });

    child.on("error", (error) => {
      this.logger.error("Failed to start codex app-server", error);
    });

    this.process = child;
    this.client = new JsonRpcClient(child.stdin, child.stdout);
    this.client.on("error", (error) => {
      this.logger.error("JSON-RPC client error", error);
    });

    return this.client;
  }

  async stop(): Promise<void> {
    this.client?.dispose();
    this.client = null;

    if (!this.process) {
      return;
    }

    const processToStop = this.process;
    this.process = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      let timeout: NodeJS.Timeout | null = null;

      const finish = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve();
      };

      processToStop.once("exit", () => finish());

      const terminated = processToStop.kill("SIGTERM");
      if (!terminated) {
        finish();
        return;
      }

      timeout = setTimeout(() => {
        if (processToStop.exitCode === null && processToStop.signalCode === null) {
          this.logger.warn("codex app-server did not exit after SIGTERM, forcing SIGKILL");
          processToStop.kill("SIGKILL");
        }
      }, CodexAppServer.SHUTDOWN_TIMEOUT_MS);
    });
  }

  private getCodexExecutable(): string {
    const binaryName = process.platform === "win32" ? "codex.cmd" : "codex";
    return path.join(process.cwd(), "node_modules", ".bin", binaryName);
  }

  private async getChildEnvironment(): Promise<NodeJS.ProcessEnv> {
    const env = { ...process.env };

    try {
      const codexHome = await this.resolveChildCodexHome();
      if (codexHome) {
        env.CODEX_HOME = codexHome;
        this.logger.info("Configured CODEX_HOME for codex app-server", {
          codexHome,
          source: codexHome === this.projectCodexHomeDir ? "workspace" : "user-home",
        });
      }
    } catch (error) {
      this.logger.warn("Failed to resolve CODEX_HOME for codex app-server, using inherited environment", error);
    }

    return env;
  }

  private async resolveChildCodexHome(): Promise<string | undefined> {
    if (await directoryExists(this.projectCodexHomeDir)) {
      return this.projectCodexHomeDir;
    }

    if (await directoryExists(USER_CODEX_HOME_DIR)) {
      return USER_CODEX_HOME_DIR;
    }

    return undefined;
  }
}

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}
