# Codex Discord Bridge — Technical Plan

## 1. Project Goal

Build a simple bridge between **Discord** and **Codex (`codex app-server`)** so that:

- a message on a Discord channel becomes input to Codex
- the bridge maintains a single Codex session/thread
- the agent's response is posted back to the same Discord channel
- everything runs locally on a developer machine

The project will be developed using:

- **Windows 11**
- **WSL2 (Ubuntu)**
- **VS Code Dev Containers**

Therefore the repository must include container configuration from the start.

---

## 2. High-Level Architecture

```
Discord channel
    ↓
Node.js bridge
    ↓
codex app-server (child process)
    ↓
Codex thread/session
    ↓
Node.js bridge
    ↓
Discord channel
```

The bridge does **not** control the VS Code extension.
VS Code is only used as the development environment.

---

## 3. MVP Scope

The first version should support only the minimal flow:

1. the bot listens on a single Discord channel
2. when a message appears it is sent to `codex app-server`
3. the bridge receives events from the app-server
4. the final agent response is sent back to Discord

Not included in MVP:

- speech-to-text
- text-to-speech
- multiple channels
- multiple concurrent threads
- tool approvals
- patch previews
- live streaming token output
- VS Code automation

---

## 4. Technology Stack

### Runtime

- **Node.js 22**
- **TypeScript**
- **npm**

### Libraries

- `discord.js`
- lightweight internal JSON-RPC client over stdio
- optional: `zod` for validation
- optional: `dotenv` for environment variables

### Codex Integration

- spawn `codex app-server` as a child process
- communicate via `stdin` / `stdout`
- messages are **JSON line-delimited (JSONL)**

---

## 5. Environment Assumptions

Development environment:

- Windows 11
- WSL2 (Ubuntu)
- Docker Desktop
- VS Code Dev Containers

The project must bootstrap its environment automatically via Dev Container configuration.

---

## 6. Repository Structure

Proposed repository layout:

```
codex-discord-bridge/
├─ .devcontainer/
│  ├─ devcontainer.json
│  ├─ Dockerfile
│  └─ docker-compose.yml
├─ src/
│  ├─ index.ts
│  ├─ discord/
│  │  └─ bot.ts
│  ├─ codex/
│  │  ├─ appServer.ts
│  │  ├─ jsonRpcClient.ts
│  │  └─ session.ts
│  ├─ config/
│  │  └─ env.ts
│  └─ utils/
│     └─ chunkMessage.ts
├─ .env.example
├─ .gitignore
├─ package.json
├─ tsconfig.json
├─ README.md
└─ TECHNICAL_PLAN.md
```

---

## 7. Dev Container Requirements

### 7.1 Dockerfile

The Docker image must provide:

- Node.js 22
- git
- bash / shell utilities
- build-essential tools
- optional: global install of `@openai/codex`

Decision:

- either install Codex inside the container
- or require the developer to install it manually

Installing Codex inside the container simplifies onboarding.

---

### 7.2 devcontainer.json

Responsibilities:

- build container from the local Dockerfile
- mount the workspace
- configure VS Code extensions
- set working directory
- run `npm install` on first container start

---

### 7.3 docker-compose.yml

Optional but useful for:

- explicit service naming
- volume configuration
- future service expansion

For MVP only a single service is required.

---

## 8. .gitignore

The repository must ignore development artifacts:

```
node_modules/
dist/
.env
.env.local
npm-debug.log*
coverage/
.vscode/
.DS_Store
*.tsbuildinfo
```

Additionally ignore Codex local state:

```
.codex/
```

This prevents committing local sessions or authentication files.

---

## 9. Environment Configuration

The bridge should rely on environment variables.

Example `.env` configuration:

```
DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=
CODEX_CWD=/workspace
LOG_LEVEL=info
```

Restricting the bot to a single channel simplifies MVP behavior.

---

## 10. Application Modules

### jsonRpcClient

Responsibilities:

- send JSON-RPC requests
- map request `id` to promises
- process responses
- process notifications/events

---

### appServer

Responsibilities:

- spawn `codex app-server`
- connect stdin/stdout streams
- monitor process lifecycle

---

### session

Responsibilities:

- perform initialization handshake
- call `initialize`
- call `thread/start`
- call `turn/start`
- maintain the current `threadId`

---

### discord bot

Responsibilities:

- connect to Discord
- listen to a configured channel
- ignore messages from bots
- send responses back to the channel

---

### chunkMessage

Responsibilities:

- split long responses
- respect Discord's 2000 character message limit

---

## 11. Application Flow

### Startup

1. start bridge process
2. spawn `codex app-server`
3. complete JSON-RPC handshake
4. create a new Codex thread
5. connect Discord bot

---

### Message Handling

1. user sends message on Discord
2. bridge extracts text
3. bridge calls `turn/start`
4. bridge collects events from Codex
5. bridge builds final output
6. bridge sends response to Discord

---

## 12. Design Decisions

### Single Session

For MVP:

- one Discord channel
- one Codex thread
- one conversation context

This significantly simplifies implementation.

---

### No Streaming in MVP

Initial implementation sends a **single final response** instead of streaming tokens.

Streaming can be added later by editing a Discord message during generation.

---

### No Database

For MVP all state can remain in process memory.

Persistent storage is not required initially.

---

## 13. Implementation Phases

### Phase 1 — Repository Bootstrap

- create repository
- add `package.json`
- add `tsconfig.json`
- add `.gitignore`
- add `.env.example`

---

### Phase 2 — Development Environment

- implement `Dockerfile`
- implement `.devcontainer/devcontainer.json`
- implement `.devcontainer/docker-compose.yml`
- verify container startup

---

### Phase 3 — Codex Integration

- spawn `codex app-server`
- implement JSON-RPC client
- test `initialize` and `thread/start`

---

### Phase 4 — Discord Integration

- create Discord bot
- authenticate with token
- listen to one channel

---

### Phase 5 — Input/Output Pipeline

- forward Discord message to Codex
- receive final response
- send response back to Discord

---

### Phase 6 — Hardening

- error handling
- process restart detection
- logging
- message chunking

---

## 14. Technical Risks

### Codex app-server stability

The app-server interface may evolve, so the bridge should remain a thin integration layer.

---

### Discord message limits

Discord limits messages to 2000 characters.

Responses must be split accordingly.

---

### Process crashes

If `codex app-server` crashes the bridge must detect it and fail clearly or restart.

---

### Session state

Loss of `threadId` means conversation context is lost.

For MVP this is acceptable.

---

## 15. MVP Success Criteria

The MVP is considered complete when:

1. the project runs inside a Dev Container under WSL
2. the Discord bot connects successfully
3. a message from Discord reaches Codex
4. Codex returns a response
5. the response appears on the Discord channel

---

## 16. Initial Files Required

The first commit should include:

```
.devcontainer/Dockerfile
.devcontainer/devcontainer.json
.devcontainer/docker-compose.yml
.gitignore
.env.example
package.json
tsconfig.json
README.md
TECHNICAL_PLAN.md
```

---

## 17. Core Definition of the Project

This project is fundamentally:

```
A text bridge between Discord and codex app-server
```

This design avoids the complexity of VS Code automation, GUI control, or audio routing and focuses purely on reliable text-based interaction.

---

## 18. Routines Concept Review

### Summary

The idea is strong and worth building, but it should be treated as a second orchestration layer on top of the existing bridge, not as a small extension of message handling.

What makes it good:

- it turns the bridge from a reactive chat bot into a scheduled autonomous agent
- it reuses the existing Codex session model and Discord event streaming
- it gives a clean user-facing control surface through Discord slash commands
- it fits naturally into `.codex-discord/` as project-local automation state

Main risks:

- routine scheduling, execution, retries, and reporting can become their own subsystem
- sharing one session between user traffic and background routines would create context pollution
- long-running or overlapping routines need explicit concurrency rules
- routine state must survive restarts cleanly

Recommended direction:

- keep routines in a dedicated file under `.codex-discord/`
- give each routine its own persistent Codex thread/session id
- keep routine execution separated from normal user-driven turns
- send routine progress and results to Discord, but clearly label them as routine output

---

## 19. Routines File Proposal

Suggested file:

```text
.codex-discord/routines.json
```

Suggested shape:

```json
{
  "routines": [
    {
      "id": "daily-review",
      "enabled": true,
      "name": "Daily review",
      "instruction": "Review recent changes and report risky areas.",
      "schedule": {
        "type": "interval",
        "minutes": 1440
      },
      "codexThreadId": "",
      "lastRunAt": null,
      "lastSuccessAt": null,
      "lastFailureAt": null,
      "nextRunAt": null,
      "discordChannelId": "",
      "createdAt": "",
      "updatedAt": ""
    }
  ]
}
```

Why this shape:

- `id` gives a stable handle for slash commands
- `enabled` allows quick pause without deletion
- `instruction` keeps the routine self-contained
- `schedule` leaves room for later support of cron-like rules
- `codexThreadId` keeps each routine in its own long-lived context
- `last*` timestamps make scheduling, retry, and diagnostics easier

---

## 20. Architecture Recommendation

Add a dedicated routines subsystem instead of folding this into the Discord bot directly.

Suggested modules:

- `src/routines/store.ts`
- `src/routines/scheduler.ts`
- `src/routines/runner.ts`
- `src/routines/types.ts`

Responsibilities:

- `store`: load, validate, save `routines.json`
- `scheduler`: decide what should run and when
- `runner`: execute a routine by sending its instruction to a dedicated Codex thread
- Discord bot: expose `/routines` management commands and publish routine output

Important boundary:

- Discord message handling remains user-driven
- routines are system-driven jobs
- these two flows should share transport primitives, but not share orchestration logic

---

## 21. Scheduling Strategy

Recommended first version:

- poll every 30 to 60 seconds
- compute `nextRunAt` from the saved routine state
- run only enabled routines
- skip overlapping execution for the same routine
- allow only one active run per routine

Recommended concurrency rule for MVP:

- multiple different routines may run one at a time globally
- no overlapping execution of the same routine

Reason:

- global serialization is simpler and avoids Codex contention during the first version
- per-routine isolation can come later if needed

---

## 22. Codex Session Model for Routines

Strong recommendation:

- do not reuse the main Discord conversation thread for routines
- each routine should own its own `codexThreadId`

Why:

- user chat context and background maintenance tasks will otherwise contaminate each other
- routine memory should remain stable across runs
- routine output becomes easier to reason about and debug

Execution flow:

1. scheduler decides the routine should run
2. runner loads or creates the routine thread
3. runner sends the routine instruction as a normal Codex turn
4. runner streams progress events to Discord
5. runner posts the final result to Discord
6. runner updates `lastRunAt`, `lastSuccessAt` or `lastFailureAt`, and `nextRunAt`

---

## 23. Discord UX Recommendation

Use slash commands rather than free-form text management.

Recommended command surface:

- `/routines list`
- `/routines add`
- `/routines edit`
- `/routines remove`
- `/routines enable`
- `/routines disable`
- `/routines run`

For MVP, keep command arguments explicit instead of building a rich form UI.

Example:

- `/routines add name:"Daily review" interval_minutes:1440 instruction:"Review recent changes and post a short status report."`

Routine output in Discord should include:

- routine name
- start time
- current status
- final result or failure

This should be clearly labeled so it does not look like a direct user reply.

---

## 24. Event Streaming Recommendation

Your idea to stream routine progress events and final result to Discord is correct.

Recommended behavior:

- progress updates should edit one status message, just like the current Codex progress mirror
- final result should be posted as a normal final message
- failures should post a concise failure summary

This keeps routine runs visible without flooding the channel.

---

## 25. Data and Failure Model

Minimum persistence requirements:

- routine definitions in `.codex-discord/routines.json`
- per-routine thread id
- last execution timestamps
- execution lock state only in memory

Recommended first failure policy:

- if a run fails, mark `lastFailureAt`
- do not immediately retry
- wait until the next scheduled interval

This is intentionally conservative and easier to reason about.

---

## 26. Implementation Plan

### Phase A — Data Model

- define `RoutineDefinition` and `RoutineSchedule`
- create loader/saver for `.codex-discord/routines.json`
- validate malformed or partial routine data safely

### Phase B — Scheduler

- add a background timer in the app runtime
- compute due routines
- prevent duplicate execution of the same routine

### Phase C — Routine Runner

- add a routine-specific Codex execution path
- store and reuse per-routine thread ids
- persist run timestamps and status

### Phase D — Discord Output

- stream routine progress into one editable status message
- send final routine result to Discord
- clearly label routine-originated messages

### Phase E — Slash Command Management

- add `/routines list`
- add `/routines add`
- add `/routines remove`
- add `/routines enable` and `/routines disable`
- add `/routines run`

### Phase F — Hardening

- handle corrupted `routines.json`
- handle restart recovery cleanly
- ensure a routine cannot execute twice after restart drift
- add visibility in logs and `doctor`

---

## 27. Overall Assessment

This is a good next-stage feature.

It pushes the project from:

- "Discord as a remote terminal for Codex"

toward:

- "Discord as a control plane for a persistent Codex worker"

That is a meaningful product step, not just a cosmetic extension.

Recommended priority:

- do it after npm-install ergonomics is stable
- keep V1 of routines intentionally narrow
- prefer reliable interval-based scheduling before adding cron syntax or advanced policies
