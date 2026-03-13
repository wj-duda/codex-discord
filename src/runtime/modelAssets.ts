import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../config/env.js";
import { Logger } from "../utils/logger.js";

const MODELS_DIR = path.join(process.cwd(), "models");

export async function ensureModelAssets(config: AppConfig, logger: Logger): Promise<AppConfig> {
  await mkdir(MODELS_DIR, { recursive: true });

  const whisperModelPath = await resolveAsset(config.whisperModelPath, logger, "whisper model");
  const piperModelPath = await resolveAsset(config.piperModelPath, logger, "piper model");
  const piperModelConfigPath = await resolveAsset(config.piperModelConfigPath, logger, "piper model config");

  return {
    ...config,
    whisperModelPath,
    piperModelPath,
    piperModelConfigPath,
  };
}

async function resolveAsset(value: string | undefined, logger: Logger, label: string): Promise<string | undefined> {
  if (!value) {
    return undefined;
  }

  if (!isHttpUrl(value)) {
    return value;
  }

  const filename = getFilenameFromUrl(value);
  const targetPath = path.join(MODELS_DIR, filename);

  if (await fileExists(targetPath)) {
    logger.info(`Model ready: ${label}`, { path: targetPath });
    return targetPath;
  }

  logger.info(`Downloading ${label}`, { url: value, path: targetPath });
  const startedAt = performance.now();
  const response = await fetch(value);
  if (!response.ok) {
    throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const tempPath = `${targetPath}.part`;
  await writeFile(tempPath, bytes);
  await rename(tempPath, targetPath);

  logger.info(`Downloaded ${label}`, {
    path: targetPath,
    sizeBytes: bytes.byteLength,
    elapsedMs: Math.round(performance.now() - startedAt),
  });

  return targetPath;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function getFilenameFromUrl(value: string): string {
  const url = new URL(value);
  const pathname = url.pathname;
  return path.basename(pathname) || "model.bin";
}
