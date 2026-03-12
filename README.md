# Codex Discord Bridge

Bridge between one Discord channel and one persistent `codex app-server` thread.

## Overview

This service:

- listens to a single configured Discord text channel
- forwards each user message to `codex app-server`
- keeps one persistent Codex thread per Discord channel
- posts the final assistant response back to Discord
- adds a compact footer with token usage and available `5h` / `7d` account limits
- sends optional startup and shutdown messages to the channel

The bridge is intentionally narrow. It is designed for a local, single-channel workflow and avoids interactive approval flows.

## Requirements

- Node.js 22+
- Discord bot token with access to the target channel
- installed project dependencies
- local `codex` binary available through `@openai/codex`

## Install

```bash
npm install
cp .env.example .env
```

## Configuration

Set these variables in `.env`:

- `DISCORD_BOT_TOKEN`: Discord bot token
- `DISCORD_CHANNEL_ID`: target Discord channel or thread id
- `DISCORD_STARTUP_MESSAGE`: optional startup message sent after the bot connects
- `DISCORD_SHUTDOWN_MESSAGE`: optional shutdown message sent before graceful stop
- `CODEX_CWD`: working directory used for Codex threads
- `CODEX_MODEL`: optional Codex model override
- `CODEX_THREAD_MAP_PATH`: path to persistent Discord channel -> Codex thread mapping
- `LOG_LEVEL`: `debug`, `info`, `warn`, or `error`

Default thread map path:

```text
/workspace/.codex-discord.json
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
5. The Discord bot logs in and optionally posts a startup message.
6. For each user message on the configured channel, the bridge starts a new `turn/start`.
7. When the turn completes, the final response is posted back to Discord.

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
2. it optionally posts the configured shutdown message
3. the Codex session is closed
4. the local `codex app-server` child process receives `SIGTERM`
5. if it does not exit within 3 seconds, it is force-killed with `SIGKILL`

If the process receives a hard kill (`SIGKILL`), no cleanup logic can run.

## Project Structure

- `src/index.ts`: process startup and shutdown wiring
- `src/discord/bot.ts`: Discord client, channel filtering, response publishing, footer formatting
- `src/codex/session.ts`: Codex thread lifecycle, turn handling, rate-limit and token-usage capture
- `src/codex/appServer.ts`: child-process lifecycle for `codex app-server`
- `src/codex/threadStore.ts`: persistent mapping between Discord channel ids and Codex thread ids
- `src/config/env.ts`: environment loading and defaults

## Current Constraints

- one configured Discord channel per bridge instance
- one persistent Codex thread per configured channel
- no streaming partial output to Discord
- approval requests are rejected automatically
- startup and shutdown announcements only work for graceful process termination

## Dev Container

The repository includes `.devcontainer/` setup for Node.js 22 and local Codex tooling.
