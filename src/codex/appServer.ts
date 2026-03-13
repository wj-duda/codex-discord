import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import { JsonRpcClient } from "./jsonRpcClient.js";
import { Logger } from "../utils/logger.js";

export class CodexAppServer {
  private static readonly SHUTDOWN_TIMEOUT_MS = 3_000;
  private process: ChildProcessWithoutNullStreams | null = null;
  private client: JsonRpcClient | null = null;

  constructor(private readonly logger: Logger) {}

  async start(): Promise<JsonRpcClient> {
    if (this.client) {
      return this.client;
    }

    const child = spawn(this.getCodexExecutable(), ["app-server"], {
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
}
