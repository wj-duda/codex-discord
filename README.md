# Codex Discord Bridge

Bridge between one Discord text channel, one optional Discord voice channel, and one persistent `codex app-server` thread.

## Overview

This service:

- listens to a single configured Discord text channel
- can also join a single configured Discord voice channel
- forwards each user message to `codex app-server`
- downloads Discord message attachments into `.codex-discord/incoming/<discord-message-id>/` and includes their local paths in the Codex prompt
- keeps one persistent Codex thread per Discord channel
- posts the final assistant response back to Discord
- can upload generated local files such as images or documents back into Discord when Codex returns saved paths or when the response uses an explicit `[zalaczniki do discorda]` block
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

To use this as a tool inside another repository:

```bash
pnpm add git+https://github.com/wj-duda/codex-discord.git
pnpm exec codex-discord init
pnpm exec codex-discord doctor
pnpm exec codex-discord setup
pnpm exec codex-discord start
```

Instalacja z repo buduje `dist/` automatycznie przez skrypt `prepare`.
Pakiet udostepnia CLI przez `bin`, wiec uruchamiasz go przez `npx codex-discord ...` albo `pnpm exec codex-discord ...`.
Nie dopisuje automatycznie skryptow do `package.json` projektu, do ktorego go instalujesz.

Environment requirements for that flow:

- project dependencies must be installed so `node_modules/.bin/codex` exists
- either `<CODEX_CWD>/.codex` or `~/.codex` must already exist in that environment
- `ffmpeg`, `whisper-cli`, and `piper` must be available in `PATH` or configured in `.env`

At startup, the bridge points the child `codex app-server` at `<CODEX_CWD>/.codex`
when that directory exists. Otherwise it falls back to `~/.codex`.
It does not copy or seed files between those locations.

If neither `<CODEX_CWD>/.codex` nor `~/.codex` exists, install the Codex VS Code extension in that environment first. This bridge reuses that existing Codex installation.

Then initialize the working directory:

```bash
npx codex-discord init
```

Optional setup step:

```bash
npx codex-discord setup
```

`setup`:

- creates `.codex-discord/incoming/`
- creates `.codex-discord/models/`
- creates `.codex-discord/models/messages.json` if it does not exist yet
- reads `.env`
- downloads Whisper/Piper model files when their env values are HTTP URLs
- resolves remote audio URLs referenced from `messages.json`
- warns if configured binary paths do not exist yet

You can rerun it manually at any time.

`init` can walk you through the required Discord env values interactively when the shell is attached to a TTY.

It also supports non-interactive prefilling of the main values:

```bash
codex-discord init --non-interactive \
  --token YOUR_DISCORD_BOT_TOKEN \
  --channel YOUR_DISCORD_CHANNEL_ID \
  --voice-channel YOUR_DISCORD_VOICE_CHANNEL_ID \
  --pre-prompt "Default to Polish for user-facing responses."
```

## CLI

The package exposes:

```bash
codex-discord init
codex-discord setup
codex-discord doctor
codex-discord status
codex-discord start
```

Typical first run:

```bash
npx codex-discord init
npx codex-discord doctor
npx codex-discord status
npx codex-discord setup
npx codex-discord start
```

Typical first run in another project:

```bash
pnpm add git+https://github.com/wj-duda/codex-discord.git
pnpm exec codex-discord init
pnpm exec codex-discord doctor
pnpm exec codex-discord status
pnpm exec codex-discord setup
pnpm exec codex-discord start
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
- `CODEX_CWD`: working directory used for Codex threads and the preferred `<CODEX_CWD>/.codex` lookup
- `CODEX_MODEL`: optional Codex model override
- `CODEX_PRE_PROMPT`: optional text prepended to every user message sent to Codex
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
    "startup",
    "Wracam."
  ],
  "discordWorkingSfx": [
    "keyboard",
    "https://example.com/loop.mp3"
  ],
  "discordCodexToolMessages": [
    "Sprawdzam to.",
    "I am checking the files."
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
9. Discord file attachments are mirrored into `.codex-discord/incoming/<discord-message-id>/` and forwarded as local file paths; replies and reactions preserve that attachment context.
10. Codex-generated files can be attached back to the Discord reply from saved Codex outputs or from an explicit `[zalaczniki do discorda]` block in the response.
11. During the turn, progress events from Codex can trigger short spoken status updates and optional working SFX.
12. Text changes in `messages.json` are hot-reloaded without restarting the bridge.
13. Codex progress updates can be mirrored into one live Discord status message that is edited as work continues.
14. When the turn completes, the final response is posted back to Discord and can be spoken in the voice channel.

## Voice Features

- Discord voice messages are downloaded, decoded with `ffmpeg`, and transcribed locally with Whisper.
- Discord voice-channel speech is captured from the configured voice channel, filtered, transcribed, and forwarded to Codex.
- Very short or low-confidence STT output is rejected before it reaches Codex.
- Voice playback can be interrupted by user speech and supports short stop commands such as `stop`, `that is enough`, and `end`.
- Piper output is chunked into short sentences for faster playback and easier interruption.
- If a voice notification variant is plain text, the same text can also be mirrored to the Discord text channel.

## SFX

- Startup, shutdown, and working cues live in `messages.json` under `discordStartupSfx`, `discordShutdownSfx`, and `discordWorkingSfx`.
- `codex-discord init` points to the built-in packaged samples `startup`, `shutdown`, and `keyboard`.
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
- `assets/defaults/sfx/`: packaged default startup / shutdown / working sound effects used directly by bootstrap

## Current Constraints

- one configured Discord channel per bridge instance
- one persistent Codex thread per configured channel
- no streaming partial text output to Discord
- approval requests are rejected automatically
- voice mode is single-channel and tuned for one operator workflow, not multi-user voice rooms
- startup and shutdown announcements only work for graceful process termination

## Dev Container

The repository includes `.devcontainer/` setup for Node.js 22 and local Codex tooling.
