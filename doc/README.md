# Codex App Server Protocol Docs

This directory contains generated reference documentation for the local `codex app-server` protocol used by this project.

The files here were generated from the installed `@openai/codex` package and copied into the repository so the protocol shape is available offline, reviewable in pull requests, and stable across local development environments.

## What This Documentation Is

This is not hand-written product documentation.

It is a checked-in snapshot of generated protocol artifacts:

- JSON Schema files describing requests, responses, notifications, and event payloads.
- TypeScript type definitions generated from the same protocol contracts.
- Versioned protocol variants where available, including `v1` and `v2`.

These files are useful when:

- inspecting the exact shape of `codex app-server` notifications,
- integrating new protocol events,
- validating token usage and rate limit payloads,
- reviewing protocol changes after upgrading `@openai/codex`.

## Directory Layout

- [codex-app-server/schema](/workspace/doc/codex-app-server/schema): top-level JSON Schema output.
- [codex-app-server/schema/v1](/workspace/doc/codex-app-server/schema/v1): version 1 schema artifacts.
- [codex-app-server/schema/v2](/workspace/doc/codex-app-server/schema/v2): version 2 schema artifacts.
- [codex-app-server/ts](/workspace/doc/codex-app-server/ts): top-level generated TypeScript types.
- [codex-app-server/ts/v2](/workspace/doc/codex-app-server/ts/v2): version 2 generated TypeScript types.
- [codex-app-server/ts/serde_json](/workspace/doc/codex-app-server/ts/serde_json): helper JSON value typings used by generated files.

## Important Entry Files

These are the main files worth opening first:

- [codex-app-server/schema/codex_app_server_protocol.schemas.json](/workspace/doc/codex-app-server/schema/codex_app_server_protocol.schemas.json): aggregate JSON Schema bundle.
- [codex-app-server/schema/codex_app_server_protocol.v2.schemas.json](/workspace/doc/codex-app-server/schema/codex_app_server_protocol.v2.schemas.json): aggregate JSON Schema bundle for protocol v2.
- [codex-app-server/schema/ServerNotification.json](/workspace/doc/codex-app-server/schema/ServerNotification.json): server notification definitions.
- [codex-app-server/schema/ServerRequest.json](/workspace/doc/codex-app-server/schema/ServerRequest.json): server-initiated request definitions.
- [codex-app-server/schema/ClientRequest.json](/workspace/doc/codex-app-server/schema/ClientRequest.json): client request definitions.
- [codex-app-server/schema/EventMsg.json](/workspace/doc/codex-app-server/schema/EventMsg.json): raw event message definitions.
- [codex-app-server/ts/index.ts](/workspace/doc/codex-app-server/ts/index.ts): top-level TypeScript export surface.
- [codex-app-server/ts/ServerNotification.ts](/workspace/doc/codex-app-server/ts/ServerNotification.ts): generated TypeScript notification union.
- [codex-app-server/ts/ClientRequest.ts](/workspace/doc/codex-app-server/ts/ClientRequest.ts): generated TypeScript client request union.
- [codex-app-server/ts/v2/index.ts](/workspace/doc/codex-app-server/ts/v2/index.ts): top-level TypeScript export surface for protocol v2.

## Notable Files For This Project

These files are especially relevant to the Discord bridge implementation:

- [codex-app-server/schema/v2/ThreadTokenUsageUpdatedNotification.json](/workspace/doc/codex-app-server/schema/v2/ThreadTokenUsageUpdatedNotification.json): token usage updates for a thread and turn.
- [codex-app-server/schema/v2/AccountRateLimitsUpdatedNotification.json](/workspace/doc/codex-app-server/schema/v2/AccountRateLimitsUpdatedNotification.json): rate limit snapshot updates.
- [codex-app-server/schema/v2/TurnCompletedNotification.json](/workspace/doc/codex-app-server/schema/v2/TurnCompletedNotification.json): turn completion payload.
- [codex-app-server/schema/v2/AgentMessageDeltaNotification.json](/workspace/doc/codex-app-server/schema/v2/AgentMessageDeltaNotification.json): streamed assistant message chunks.
- [codex-app-server/ts/v2/ThreadTokenUsageUpdatedNotification.ts](/workspace/doc/codex-app-server/ts/v2/ThreadTokenUsageUpdatedNotification.ts): TypeScript type for token usage updates.
- [codex-app-server/ts/v2/ThreadTokenUsage.ts](/workspace/doc/codex-app-server/ts/v2/ThreadTokenUsage.ts): TypeScript structure for aggregated and last-turn token usage.
- [codex-app-server/ts/v2/TokenUsageBreakdown.ts](/workspace/doc/codex-app-server/ts/v2/TokenUsageBreakdown.ts): token count breakdown fields.
- [codex-app-server/ts/v2/RateLimitSnapshot.ts](/workspace/doc/codex-app-server/ts/v2/RateLimitSnapshot.ts): rate limit snapshot structure.

## Regeneration

If the installed Codex package changes, regenerate these files and replace the checked-in snapshot.

The original artifacts were produced from:

- `codex app-server generate-json-schema`
- `codex app-server generate-ts`

## Notes

- Most files in this directory are generated.
- They should be treated as reference material, not edited manually.
- If the protocol changes after a package upgrade, review the diff in this directory before updating runtime code.
