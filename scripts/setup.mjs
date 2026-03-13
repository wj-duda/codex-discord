import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { config as loadDotenv } from "dotenv";

const ROOT_DIR = process.cwd();
const MODELS_DIR = path.join(ROOT_DIR, "models");

const ASSET_ENV_VARS = [
  ["WHISPER_MODEL_PATH", "whisper model"],
  ["PIPER_MODEL_PATH", "piper model"],
  ["PIPER_MODEL_CONFIG_PATH", "piper model config"],
];

const BINARY_ENV_VARS = [
  ["FFMPEG_PATH", "ffmpeg"],
  ["WHISPER_CPP_PATH", "whisper-cli"],
  ["PIPER_PATH", "piper"],
];

async function main() {
  loadDotenv({ override: false });

  await mkdir(MODELS_DIR, { recursive: true });
  logInfo(`models directory ready: ${MODELS_DIR}`);

  for (const [envName, label] of BINARY_ENV_VARS) {
    const configuredPath = process.env[envName]?.trim();
    if (!configuredPath) {
      continue;
    }

    const exists = await fileExists(configuredPath);
    if (exists) {
      logInfo(`${label} configured: ${configuredPath}`);
      continue;
    }

    logWarn(`${label} path from ${envName} does not exist: ${configuredPath}`);
  }

  for (const [envName, label] of ASSET_ENV_VARS) {
    const value = process.env[envName]?.trim();
    if (!value) {
      logInfo(`${envName} is not set, skipping ${label}`);
      continue;
    }

    if (!isHttpUrl(value)) {
      const exists = await fileExists(value);
      if (exists) {
        logInfo(`${label} already available: ${value}`);
      } else {
        logWarn(`${label} path from ${envName} does not exist yet: ${value}`);
      }
      continue;
    }

    const filename = getFilenameFromUrl(value);
    const targetPath = path.join(MODELS_DIR, filename);
    if (await fileExists(targetPath)) {
      logInfo(`${label} already downloaded: ${targetPath}`);
      continue;
    }

    await downloadAsset(value, targetPath, label);
  }
}

async function downloadAsset(url, targetPath, label) {
  logInfo(`downloading ${label}: ${url}`);
  const startedAt = performance.now();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${label}: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const tempPath = `${targetPath}.part`;
  await writeFile(tempPath, bytes);
  await rename(tempPath, targetPath);

  logInfo(
    `downloaded ${label}: ${targetPath} (${formatBytes(bytes.byteLength)}, ${Math.round(performance.now() - startedAt)} ms)`,
  );
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(value) {
  return value.startsWith("http://") || value.startsWith("https://");
}

function getFilenameFromUrl(value) {
  const url = new URL(value);
  return path.basename(url.pathname) || "asset.bin";
}

function formatBytes(value) {
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function logInfo(message) {
  console.log(`[setup] ${message}`);
}

function logWarn(message) {
  console.warn(`[setup] WARN ${message}`);
}

main().catch((error) => {
  console.error("[setup] FAILED", error instanceof Error ? error.message : error);
  process.exit(1);
});
