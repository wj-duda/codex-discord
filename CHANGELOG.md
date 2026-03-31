# Changelog

All notable changes to this project are documented in this file.

## [0.3.6] - 2026-03-31

### Changed

- Recurring work is now branded consistently as chores: the Discord command base is `/chores`, the local storage directory is `.codex-discord/chores/`, and the related config env var is `CODEX_CHORES_PATH`.
- Scheduled chore announcements now come from `discordScheduledChoreStartMessages` in `messages.json`, with richer bundled variants in `en-john`, `pl-gosia`, and especially `pl-kotex`.

## [0.3.5] - 2026-03-31

### Added

- Scheduled task storage under `.codex-discord/tasks/<guid>/` with per-task `meta.json` and isolated `memory.json` session memory.
- Background task watching and hot reloading for task directories created, deleted, or modified on disk.
- A dedicated `SessionMemory` class extracted from the previous thread-store implementation so the main bridge and scheduled tasks share the same memory format.
- Configurable `discordScheduledTaskStartMessages` message variants with `{name}` and `{frequency}` placeholders for task start announcements.
- Per-task `silentTurns` settings stored in task memory so voice output can be limited to the final summary only.

### Changed

- Recurring task management now uses `/task add`, `/task list`, `/task run`, and `/task delete` in Discord.
- User-facing task lists and pickers hide GUIDs, show voice status with `🔇` / `🔊`, and use bilingual PL/EN command hints.

## [0.3.0] - 2026-03-30

### Added

- Event-driven turn speech coordination that queues full spoken sentences, tracks completed playback, and reconciles live turn speech with final summaries.
- A dedicated speech runtime layer that keeps live voice rendering and Discord playback separate from the main bot flow.
- Vitest-based test coverage for voice coordination, runtime wiring, environment auto-discovery, and isolated CLI setup with remote asset downloads.
- Voice startup diagnostics that report whether input, output, or full voice mode was enabled from the current local setup.
- A startup Discord embed for voice auto-discovery with per-feature checks, missing prerequisites, and a direct link to the GitHub README.

### Changed

- Voice is now optional and the bridge defaults to text-only mode when voice transport is not configured.
- Voice readiness is auto-discovered from the configured environment, especially `DISCORD_VOICE_CHANNEL_ID`, with per-feature overrides still available.
- `setup` only downloads voice-related models and message audio assets for the features that are actually enabled.
- Default startup, shutdown, and working cues now use bundled neutral aliases: `startup`, `shutdown`, and `keyboard`.
- CLI and runtime voice readiness messages are now consistently in English.
- The README now documents the current `0.3.0` behavior and links to this changelog for release notes.

### Fixed

- Removed legacy League of Legends / Fandom-specific defaults and HTTP header workarounds from asset setup.
- Prevented final voice summaries from replaying content that was already spoken earlier in the same active turn.
- Kept voice setup and doctor flows usable in text-only environments without requiring Whisper or Piper.
