# Codex Discord Bridge

Bridge between one Discord text channel, one optional Discord voice channel, and one persistent `codex app-server` thread.

## Overview

This service:

- listens to a single configured Discord text channel
- can also join a single configured Discord voice channel
- defaults to text-only mode when no voice channel is configured
- auto-discovers voice readiness when a voice channel is configured
- forwards each user message to `codex app-server`
- downloads Discord message attachments into `.codex-discord/incoming/<discord-message-id>/` and includes their local paths in the Codex prompt
- keeps one persistent Codex thread per Discord channel
- posts the final assistant response back to Discord
- can upload generated local files such as images or documents back into Discord when Codex returns saved paths or when the response uses an explicit `[zalaczniki do discorda]` block
- can transcribe Discord voice messages and voice-channel speech with local Whisper
- can read responses back through a local Piper voice in a Discord voice channel
- can run recurring background chores from `.codex-discord/chores/<guid>/` with isolated Codex memory per chore
- adds a compact footer with token usage and available `5h` / `7d` account limits
- sends configurable startup and shutdown messages to the channel

The bridge is intentionally narrow. It is designed for a local, single-channel workflow and avoids interactive approval flows.

## Version 0.3.6 Status

This README currently documents version `0.3.6`.
For release notes, see [CHANGELOG.md](./CHANGELOG.md).

Current `0.3.6` highlights:

- installable directly from GitHub as a packaged CLI with bundled `dist/`
- one persistent Codex thread per Discord channel with preferred `<CODEX_CWD>/.codex` lookup
- text-first runtime with optional voice input and voice output flags
- text-only mode by default, with voice auto-discovery when a voice channel is configured
- event-driven turn speech coordination for live sentence queueing, playback tracking, and summary reconciliation
- bundled message and voice packs such as `pl-kotex`, `pl-gosia`, and `en-john`
- neutral bundled startup, shutdown, and working cues via `startup`, `shutdown`, and `keyboard`
- startup voice auto-discovery is posted as a color-coded Discord embed with checks, missing items, and a direct link to the GitHub README
- steering messages are attached to the active Codex session instead of getting their own hanging Discord lifecycle
- recurring chores live under `.codex-discord/chores/<guid>/`, keep their own Codex memory, and can be managed through `/chores add`, `/chores list`, `/chores run`, and `/chores delete`
- final Discord reply prefers the real final response over reasoning summary
- footer shows reset date for the long window, for example `13 Mar 64%`
- runtime logs are written under `.codex-discord/`
- Vitest coverage now includes speech coordination, voice config auto-discovery, and isolated CLI setup integration

Not finished in `0.3.6`:

- no streaming partial final text output to Discord; only one live progress mirror plus the final reply
- no multi-user voice-room workflow; voice mode is still tuned for one operator channel
- no published npm registry release; distribution is through GitHub install or Git tags
- no automated end-to-end integration suite for long-running Discord and Codex runtime scenarios
- no support for interactive approval flows; approval is still forced to `never`

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
pnpm add git+https://github.com/wj-duda/codex-discord.git#v0.3.6
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
- `ffmpeg`, `whisper-cli`, and `piper` are only needed when the corresponding voice features are enabled; text-only mode can run without them

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
- creates `.codex-discord/chores/`
- creates `.codex-discord/models/messages.json` if it does not exist yet
- reads `.env`
- downloads Whisper/Piper model files only for enabled voice features when their env values are HTTP URLs
- resolves remote audio URLs referenced from `messages.json` only for enabled voice-output assets
- warns if configured binary paths do not exist yet

You can rerun it manually at any time.

## Text-Only Mode

Text-only is the default mode.

For a text-only setup:

- leave `DISCORD_VOICE_ENABLED` empty or set it explicitly to `false`
- leave `DISCORD_VOICE_INPUT_ENABLED` and `DISCORD_VOICE_OUTPUT_ENABLED` empty, or set them explicitly to `false`
- `DISCORD_VOICE_CHANNEL_ID` can stay empty
- you can start the bridge without `ffmpeg`, `whisper-cli`, or `piper`
- `setup` and `doctor` will not require Whisper/Piper while voice is disabled

Text-only mode still supports:

- persistent Codex threads
- Discord attachments mirrored into `.codex-discord/incoming/`
- steering messages attached to the active Codex session
- file results uploaded back into Discord
- hot-reloaded message packs and status footers

`init` can walk you through the required Discord env values interactively when the shell is attached to a TTY.

It also supports non-interactive prefilling of the main values:

```bash
codex-discord init --non-interactive \
  --token YOUR_DISCORD_BOT_TOKEN \
  --channel YOUR_DISCORD_CHANNEL_ID \
  --voice-channel YOUR_DISCORD_VOICE_CHANNEL_ID \
  --pre-prompt "Default to Polish for user-facing responses."
```

Passing `--voice-channel` during `init` seeds voice transport for auto-discovery.

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
pnpm add git+https://github.com/wj-duda/codex-discord.git#v0.3.6
pnpm exec codex-discord init
pnpm exec codex-discord doctor
pnpm exec codex-discord status
pnpm exec codex-discord setup
pnpm exec codex-discord start
```

Bundled message packs:

```bash
pnpm exec codex-discord messages list
pnpm exec codex-discord messages install pl-kotex
pnpm exec codex-discord messages install
```

Pack names follow the convention `<language>-<voice-or-style>`, for example `pl-kotex`, `pl-gosia`, or `en-john`.
When a pack includes Piper voice metadata, `messages install` also updates `.env` and downloads the Piper model files into `.codex-discord/models/`.
If you run `messages install` without a pack name in a TTY, the CLI shows an interactive selector.

## Configuration

Set these variables in `.env`:

- `DISCORD_BOT_TOKEN`: Discord bot token
- `DISCORD_CHANNEL_ID`: target Discord channel or thread id
- `DISCORD_VOICE_ENABLED`: master voice switch; leave empty for auto-discovery, set `true` to force on, or `false` to force off
- `DISCORD_VOICE_INPUT_ENABLED`: optional override for voice input; falls back to the resolved `DISCORD_VOICE_ENABLED` value
- `DISCORD_VOICE_OUTPUT_ENABLED`: optional override for voice output; falls back to the resolved `DISCORD_VOICE_ENABLED` value
- `DISCORD_VOICE_CHANNEL_ID`: optional Discord voice channel id, needed for voice-channel capture and Discord voice playback
- `DISCORD_MESSAGES_PATH`: path to the JSON file with spoken text/audio variants and notification SFX
- `FFMPEG_PATH`: optional path to `ffmpeg`, only needed when any voice feature is enabled
- `WHISPER_CPP_PATH`: optional path to `whisper-cli`, only needed for voice input
- `WHISPER_MODEL_PATH`: local path or downloadable URL to the Whisper model, only needed for voice input
- `WHISPER_LANGUAGE`: recognition language, defaults to `pl`
- `PIPER_PATH`: optional path to `piper`, only needed for voice output
- `PIPER_MODEL_PATH`: local path or downloadable URL to the Piper voice model, only needed for voice output
- `PIPER_MODEL_CONFIG_PATH`: local path or downloadable URL to the Piper model config, only needed for voice output
- `PIPER_LENGTH_SCALE`: optional Piper speech speed / length parameter
- `PIPER_NOISE_SCALE`: optional Piper noise parameter
- `PIPER_NOISE_W`: optional Piper phoneme noise parameter
- `PIPER_SENTENCE_SILENCE`: optional Piper sentence pause in seconds
- `CODEX_CWD`: working directory used for Codex threads and the preferred `<CODEX_CWD>/.codex` lookup
- `CODEX_MODEL`: optional Codex model override
- `CODEX_PRE_PROMPT`: optional text prepended to every user message sent to Codex
- `CODEX_THREAD_MAP_PATH`: path to persistent Discord channel -> Codex thread mapping
- `CODEX_CHORES_PATH`: optional path to the directory with recurring chore folders; defaults to `.codex-discord/chores`
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
- `discordScheduledChoreStartMessages`
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
5. The Discord bot logs in, optionally joins the configured voice channel when voice transport is enabled, and posts a startup message plus a voice-status embed when voice auto-discovery runs.
6. Missed Discord text messages are replayed from the last processed message checkpoint.
7. If no missed text messages exist, the bridge can send an automatic resume prompt to Codex on startup.
8. For each text message, reaction, reply, enabled voice message, or accepted voice-channel transcript, the bridge forwards input to Codex.
9. If another Codex turn is already active, additional Discord messages are treated as steering and attached to that active session instead of getting their own Discord-side lifecycle.
10. Discord file attachments are mirrored into `.codex-discord/incoming/<discord-message-id>/` and forwarded as local file paths; replies and reactions preserve that attachment context.
11. Codex-generated files can be attached back to the Discord reply from saved Codex outputs or from an explicit `[zalaczniki do discorda]` block in the response.
12. During the turn, progress events from Codex can trigger short spoken status updates and optional working SFX.
13. Text changes in `messages.json` are hot-reloaded without restarting the bridge.
14. Codex progress updates can be mirrored into one live Discord status message that is edited as work continues.
15. When the turn completes, the final response is posted back to Discord and can be spoken in the voice channel when voice output is enabled.
16. Scheduled chores from `.codex-discord/chores/` are watched in the background and run on their own persisted Codex sessions when their interval becomes due.

## Scheduled Chores

Recurring chores live under `.codex-discord/chores/<guid>/`.
Each chore directory contains:

- `meta.json` with `name`, `description`, `frequency`, `createdAt`, and execution state fields such as `lastRunAt`
- `memory.json` in the same session-memory format as the main bridge, so every chore keeps a separate Codex thread

The bridge registers these slash commands in the configured guild channel:

- `/chores add frequency:<1-30 minutes|hours|days> name:<chore name> description:<chore instruction>`
- `/chores list`
- `/chores delete chore:<choose chore>`
- `/chores run chore:<choose chore>`

## Voice Features

All voice features below are optional. If a voice channel is configured, the bridge tries to auto-enable voice when the local requirements are satisfied.

- Discord voice messages from the text channel are downloaded, decoded with `ffmpeg`, and transcribed locally with Whisper when voice input is enabled.
- Discord voice-channel speech is captured from the configured voice channel, filtered, transcribed, and forwarded to Codex when voice input and voice transport are enabled.
- Very short or low-confidence STT output is rejected before it reaches Codex.
- Voice playback can be interrupted by user speech and supports short stop commands such as `stop`, `that is enough`, and `end`.
- Piper output is chunked into short sentences for faster playback and easier interruption.
- Progress speech and final summary share one sentence queue, so already spoken summary prefixes are preserved instead of being read twice.
- Summary reconciliation keeps matching sentences already spoken or already queued, removes mismatching queued suffixes, and appends only the missing summary suffix.
- When voice auto-discovery runs at startup, the bridge posts a compact Discord embed with enabled modes, per-feature checks, missing prerequisites, and a direct link to the project README.
- If a voice notification variant is plain text, the same text can also be mirrored to the Discord text channel.

Typical voice configurations:

- Text only: leave all `DISCORD_VOICE_*` flags disabled.
- Voice input only for Discord voice messages: set `DISCORD_VOICE_INPUT_ENABLED=true`; a voice channel id is not required for message attachments.
- Full voice channel mode: set `DISCORD_VOICE_CHANNEL_ID=<channel-id>` and let auto-discovery enable voice, or force it with `DISCORD_VOICE_ENABLED=true`.

## SFX

- Startup, shutdown, and working cues live in `messages.json` under `discordStartupSfx`, `discordShutdownSfx`, and `discordWorkingSfx`.
- `codex-discord init` points to the built-in packaged samples `startup`, `shutdown`, and `keyboard`.
- Working SFX can start from randomized offsets so repeated keyboard ambience is less obviously repetitive.

## Footer Format

The final Discord message footer is intentionally compact:

```text
📦 project-name • 🪙 4.5k • 5h 82% • 13 Mar 64%
```

Where:

- `🪙` is the last-turn token usage
- `5h` is currently available percentage for the 5-hour usage window
- `13 Mar` is the reset date label for the long usage window

## Shutdown Behavior

On graceful shutdown (`SIGINT` / `SIGTERM`):

1. the bot marks itself as shutting down
2. it posts a single shutdown message to Discord
3. if voice output is active, it adds a relative countdown, plays the shutdown cue, and waits for the configured drain window
4. if that countdown message was used, it removes it after the drain window
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
