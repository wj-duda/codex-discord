# Codex Discord Bridge

Bridge between one Discord text channel, one optional Discord voice channel, and one persistent `codex app-server` thread.

## Overview

This service:

- listens to a single configured Discord text channel
- can also join a single configured Discord voice channel
- forwards each user message to `codex app-server`
- keeps one persistent Codex thread per Discord channel
- posts the final assistant response back to Discord
- can transcribe Discord voice messages and voice-channel speech with local Whisper
- can read responses back through a local Piper voice in a Discord voice channel
- adds a compact footer with token usage and available `5h` / `7d` account limits
- sends configurable startup and shutdown messages to the channel

The bridge is intentionally narrow. It is designed for a local, single-channel workflow and avoids interactive approval flows.

## Requirements

- Node.js 22+
- Discord bot token with access to the target channel
- installed project dependencies
- local `codex` binary available through `@openai/codex`

## Install

```bash
npm install
```

Then initialize the working directory:

```bash
npx codex-discord init
```

Optional setup step:

```bash
npx codex-discord setup
```

`setup`:

- creates `.codex-discord/models/`
- creates `.codex-discord/models/messages.json` if it does not exist yet
- reads `.env`
- downloads Whisper/Piper model files when their env values are HTTP URLs
- resolves remote audio URLs referenced from `messages.json`
- warns if configured binary paths do not exist yet

You can rerun it manually at any time.

## CLI

The package exposes:

```bash
codex-discord init
codex-discord setup
codex-discord doctor
codex-discord start
```

Typical first run:

```bash
npx codex-discord init
npx codex-discord doctor
npx codex-discord setup
npx codex-discord start
```

## Configuration

Set these variables in `.env`:

- `DISCORD_BOT_TOKEN`: Discord bot token
- `DISCORD_CHANNEL_ID`: target Discord channel or thread id
- `DISCORD_VOICE_CHANNEL_ID`: optional Discord voice channel id for voice mode
- `DISCORD_MESSAGES_PATH`: path to the JSON file with spoken text/audio variants and notification SFX
- `FFMPEG_PATH`: optional path to `ffmpeg`
- `WHISPER_CPP_PATH`: optional path to `whisper-cli`
- `WHISPER_MODEL_PATH`: local path or downloadable URL to the Whisper model
- `WHISPER_LANGUAGE`: recognition language, defaults to `pl`
- `PIPER_PATH`: optional path to `piper`
- `PIPER_MODEL_PATH`: local path or downloadable URL to the Piper voice model
- `PIPER_MODEL_CONFIG_PATH`: local path or downloadable URL to the Piper model config
- `PIPER_LENGTH_SCALE`: optional Piper speech speed / length parameter
- `PIPER_NOISE_SCALE`: optional Piper noise parameter
- `PIPER_NOISE_W`: optional Piper phoneme noise parameter
- `PIPER_SENTENCE_SILENCE`: optional Piper sentence pause in seconds
- `CODEX_CWD`: working directory used for Codex threads
- `CODEX_MODEL`: optional Codex model override
- `CODEX_THREAD_MAP_PATH`: path to persistent Discord channel -> Codex thread mapping
- `LOG_LEVEL`: `debug`, `info`, `warn`, or `error`

Default thread map path:

```text
/workspace/.codex-discord/memory.json
```

Default messages config path:

```text
/workspace/.codex-discord/models/messages.json
```

`messages.json` contains all runtime message variants, including:

- `discordStartupSfx`
- `discordShutdownSfx`
- `discordWorkingSfx`
- `discordStartupMessages`
- `discordShutdownMessages`
- `discordVoiceListeningMessages`
- `discordVoiceCapturedMessages`
- `discordVoiceProcessingMessages`
- `discordVoiceRejectedMessages`
- `discordVoiceStoppedMessages`
- `discordCodexWorkingMessages`
- `discordCodexStartMessages`
- `discordCodexReasoningMessages`
- `discordCodexToolMessages`
- `discordCodexPlanMessages`

Each item in `discord*Sfx` can be one of:

- plain text, which is spoken through Piper
- local audio file path
- remote audio URL

Example:

```json
{
  "discordStartupSfx": [
    "assets/defaults/sfx/startup.wav",
    "Wracam."
  ],
  "discordWorkingSfx": [
    "assets/defaults/sfx/keyboard.wav",
    "https://example.com/loop.mp3"
  ],
  "discordCodexToolMessages": [
    "Sprawdzam to.",
    "Wchodzę w pliki."
  ]
}
```

## Run

Development:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm start
```

Type-check only:

```bash
npm run check
```

## Runtime Flow

1. The process starts `codex app-server` over stdio.
2. It sends `initialize`.
3. It restores an existing Codex thread for the configured Discord channel or creates a new one.
4. It reads account rate-limit metadata from Codex.
5. The Discord bot logs in, optionally joins the configured voice channel, and posts a startup message.
6. Missed Discord text messages are replayed from the last processed message checkpoint.
7. If no missed text messages exist, the bridge can send an automatic resume prompt to Codex on startup.
8. For each text message, reaction, reply, voice message, or accepted voice-channel transcript, the bridge starts a new `turn/start`.
9. During the turn, progress events from Codex can trigger short spoken status updates and optional working SFX.
10. Text changes in `messages.json` are hot-reloaded without restarting the bridge.
11. Codex progress updates can be mirrored into one live Discord status message that is edited as work continues.
12. When the turn completes, the final response is posted back to Discord and can be spoken in the voice channel.

## Voice Features

- Discord voice messages are downloaded, decoded with `ffmpeg`, and transcribed locally with Whisper.
- Discord voice-channel speech is captured from the configured voice channel, filtered, transcribed, and forwarded to Codex.
- Very short or low-confidence STT output is rejected before it reaches Codex.
- Voice playback can be interrupted by user speech and supports short stop commands such as `stop`, `stój`, `wystarczy`, and `koniec`.
- Piper output is chunked into short sentences for faster playback and easier interruption.
- If a voice notification variant is plain text, the same text can also be mirrored to the Discord text channel.

## SFX

- Startup, shutdown, and working cues live in `messages.json` under `discordStartupSfx`, `discordShutdownSfx`, and `discordWorkingSfx`.
- `codex-discord init` uses the built-in default samples from [`assets/defaults/sfx`](/workspace/assets/defaults/sfx) as `startup.wav`, `shutdown.wav`, and `keyboard.wav`.
- Working SFX can start from randomized offsets so repeated keyboard ambience is less obviously repetitive.

## Footer Format

The final Discord message footer is intentionally compact:

```text
📦 project-name • 🪙 4.5k • 5h 82% • 7d 64%
```

Where:

- `🪙` is the last-turn token usage
- `5h` is currently available percentage for the 5-hour usage window
- `7d` is currently available percentage for the 7-day usage window

## Shutdown Behavior

On graceful shutdown (`SIGINT` / `SIGTERM`):

1. the bot marks itself as shutting down
2. it posts a single shutdown message to Discord with a relative countdown
3. it plays the shutdown voice cue and waits for the configured drain window
4. it removes the shutdown countdown message
5. the Codex session is closed
6. the local `codex app-server` child process receives `SIGTERM`
7. if it does not exit within the fallback timeout, it is force-killed with `SIGKILL`

If the process receives a hard kill (`SIGKILL`), no cleanup logic can run.

## Project Structure

- `src/index.ts`: process startup and shutdown wiring
- `src/discord/bot.ts`: Discord client, channel filtering, response publishing, footer formatting
- `src/codex/session.ts`: Codex thread lifecycle, turn handling, rate-limit and token-usage capture
- `src/codex/appServer.ts`: child-process lifecycle for `codex app-server`
- `src/codex/threadStore.ts`: persistent mapping between Discord channel ids and Codex thread ids
- `src/config/env.ts`: environment loading and defaults
- `src/app.ts`: runtime boot, message-config hot reload
- `src/stt/localWhisper.ts`: local Whisper transcription pipeline
- `src/runtime/modelAssets.ts`: model download and local asset resolution
- `assets/defaults/sfx/`: default startup / shutdown / working sound effects used directly by bootstrap

## Current Constraints

- one configured Discord channel per bridge instance
- one persistent Codex thread per configured channel
- no streaming partial text output to Discord
- approval requests are rejected automatically
- voice mode is single-channel and tuned for one operator workflow, not multi-user voice rooms
- startup and shutdown announcements only work for graceful process termination

## Dev Container

The repository includes `.devcontainer/` setup for Node.js 22 and local Codex tooling.
