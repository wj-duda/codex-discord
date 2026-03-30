import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { buildDefaultMessagesConfig } from "../src/config/env.js";

const execFile = promisify(execFileCallback);
const REPO_ROOT = process.cwd();
const TSX_CLI_PATH = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI_ENTRY_PATH = path.join(REPO_ROOT, "src", "cli.ts");

const TEMP_DIRS: string[] = [];

afterEach(async () => {
  while (TEMP_DIRS.length > 0) {
    const tempDir = TEMP_DIRS.pop();
    if (!tempDir) {
      continue;
    }

    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("CLI setup integration", () => {
  it("creates the default messages config and downloads remote assets in an isolated workspace", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-cli-setup-"));
    TEMP_DIRS.push(tempDir);

    const requestCounts = new Map<string, number>();
    const payloads = {
      "/voice.onnx": Buffer.from("fake-piper-model"),
      "/voice.onnx.json": Buffer.from('{"audio":{"sample_rate":22050}}'),
      "/startup.wav": Buffer.from("fake-startup-audio"),
    };

    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      const pathname = requestUrl.pathname;
      requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);

      const body = payloads[pathname as keyof typeof payloads];
      if (!body) {
        response.statusCode = 404;
        response.end("not found");
        return;
      }

      response.statusCode = 200;
      response.setHeader("Content-Type", "application/octet-stream");
      response.end(body);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an IPv4 address for the test asset server");
      }

      const baseUrl = `http://127.0.0.1:${address.port}`;
      const envPath = path.join(tempDir, ".env");
      const modelsDir = path.join(tempDir, ".codex-discord", "models");
      const messagesPath = path.join(modelsDir, "messages.json");

      await writeFile(
        envPath,
        [
          "DISCORD_BOT_TOKEN=test-token",
          "DISCORD_CHANNEL_ID=test-channel",
          "DISCORD_VOICE_ENABLED=false",
          "DISCORD_VOICE_INPUT_ENABLED=false",
          "DISCORD_VOICE_OUTPUT_ENABLED=true",
          `FFMPEG_PATH=${process.execPath}`,
          `PIPER_PATH=${process.execPath}`,
          `PIPER_MODEL_PATH=${baseUrl}/voice.onnx`,
          `PIPER_MODEL_CONFIG_PATH=${baseUrl}/voice.onnx.json`,
          "",
        ].join("\n"),
        "utf8",
      );

      await runCliSetup(tempDir);

      const defaultMessages = JSON.parse(await readFile(messagesPath, "utf8")) as ReturnType<typeof buildDefaultMessagesConfig>;
      expect(defaultMessages).toEqual(buildDefaultMessagesConfig());

      const downloadedModelPath = path.join(modelsDir, "voice.onnx");
      const downloadedModelConfigPath = path.join(modelsDir, "voice.onnx.json");
      expect(await readFile(downloadedModelPath)).toEqual(payloads["/voice.onnx"]);
      expect(await readFile(downloadedModelConfigPath)).toEqual(payloads["/voice.onnx.json"]);
      expect(requestCounts.get("/voice.onnx")).toBe(1);
      expect(requestCounts.get("/voice.onnx.json")).toBe(1);

      const updatedMessages = {
        ...buildDefaultMessagesConfig(),
        discordStartupMessages: [`${baseUrl}/startup.wav`],
      };
      await writeFile(messagesPath, `${JSON.stringify(updatedMessages, null, 2)}\n`, "utf8");

      await runCliSetup(tempDir);

      const messageAudioIndexPath = path.join(modelsDir, "messages", "index.json");
      const messageAudioIndex = JSON.parse(await readFile(messageAudioIndexPath, "utf8")) as Record<string, string>;
      const cachedAudioFilename = messageAudioIndex[`${baseUrl}/startup.wav`];

      expect(cachedAudioFilename).toBeTruthy();
      expect(await readFile(path.join(modelsDir, "messages", cachedAudioFilename))).toEqual(payloads["/startup.wav"]);
      expect(requestCounts.get("/startup.wav")).toBe(1);
      expect(requestCounts.get("/voice.onnx")).toBe(1);
      expect(requestCounts.get("/voice.onnx.json")).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  });
});

async function runCliSetup(tempDir: string): Promise<void> {
  try {
    await execFile(process.execPath, [TSX_CLI_PATH, CLI_ENTRY_PATH, "setup"], {
      cwd: tempDir,
      env: createIsolatedCliEnv(),
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const details =
      error && typeof error === "object" && "stdout" in error && "stderr" in error
        ? `\nstdout:\n${String(error.stdout)}\nstderr:\n${String(error.stderr)}`
        : "";
    throw new Error(`CLI setup failed${details}`);
  }
}

function createIsolatedCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("DISCORD_") ||
      key.startsWith("WHISPER_") ||
      key.startsWith("PIPER_") ||
      key.startsWith("CODEX_") ||
      key === "FFMPEG_PATH" ||
      key === "LOG_LEVEL"
    ) {
      delete env[key];
    }
  }

  return env;
}
