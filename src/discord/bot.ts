import { execFile as execFileCallback, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import {
  Collection,
  EmbedBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
  Partials,
  type Attachment,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type MessageCreateOptions,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type TextBasedChannel,
  type User,
} from "discord.js";

import { CODEX_DISCORD_INCOMING_DIR, parseVariantEntry, type AppConfig } from "../config/env.js";
import { CodexAttachedHintTurnCancelledError, CodexSecondaryTurnCancelledError } from "../codex/errors.js";
import type {
  AccountRateLimitSnapshot,
  AccountRateLimitWindow,
  CodexProgressEvent,
  CodexProgressDetailFormat,
  CodexUserMessageMode,
  CodexTurnResult,
  CodexTurnStreamHandlers,
  ThreadTokenUsage,
} from "../types/codex.js";
import { CodexThreadStore } from "../codex/threadStore.js";
import { LocalWhisperTranscriber } from "../stt/localWhisper.js";
import { chunkMessage } from "../utils/chunkMessage.js";
import { Logger } from "../utils/logger.js";

interface ProjectInfo {
  name: string;
}

interface RenderedVoiceSpeechChunk {
  tempDir: string;
  wavPath: string;
  preview: string;
}

interface ReasoningSpeechJob {
  id: number;
  label: string;
  text: string;
  createdAt: number;
  estimatedRenderMs: number;
  estimatedPlaybackMs: number;
  cancelled: boolean;
  phase: "queued" | "rendering" | "playing" | "done";
  playbackStartedAt: number | null;
  abortController: AbortController | null;
}

const PROJECT_INFO = readProjectInfo();
const TYPING_KEEPALIVE_MS = 8_000;
const CODEX_WORKING_SPEECH_THROTTLE_MS = 7_000;
const CODEX_INFORMATIVE_SPEECH_THROTTLE_MS = 1_500;
const CODEX_REASONING_SPEECH_THROTTLE_MS = 5_000;
const PIPER_ESTIMATED_RENDER_MS_PER_WORD = 90;
const PIPER_ESTIMATED_RENDER_MIN_MS = 500;
const PIPER_ESTIMATED_AUDIO_MS_PER_WORD = 380;
const PIPER_ESTIMATED_AUDIO_MIN_MS = 1_200;
const REASONING_SUPERSEDE_READ_FRACTION = 1 / 3;
const CODEX_WORKING_SFX_INTERVAL_MS = 2_500;
const CODEX_WORKING_SFX_CLIP_DURATION_SECONDS = 0.35;
const VOICE_SPEECH_PRERENDER_CONCURRENCY = 3;
const VOICE_SFX_AFTER_SPEECH_COOLDOWN_MS = 250;
const VOICE_STOP_COMMAND_WINDOW_MS = 10_000;
const SHUTDOWN_VOICE_DRAIN_MS = 10_000;
const VOICE_CAPTURE_MIN_DURATION_MS = 1_200;
const VOICE_CAPTURE_MIN_RMS = 0.015;
const VOICE_CAPTURE_MIN_ACTIVE_RATIO = 0.07;
const VOICE_CAPTURE_AFTER_SILENCE_MS = 1_500;
const VOICE_RECONNECT_DELAY_MS = 3_000;
const VOICE_STATE_FLAP_WINDOW_MS = 12_000;
const VOICE_STATE_FLAP_THRESHOLD = 8;
const VOICE_RECONNECT_COOLDOWN_MS = 20_000;
const VOICE_RECONNECT_MAX_ATTEMPTS_PER_WINDOW = 3;
const DISCORD_MAX_ATTACHMENTS = 10;
const DISCORD_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const DISCORD_ATTACHMENT_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".pdf",
  ".js",
  ".ts",
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".zip",
  ".wav",
  ".mp3",
  ".ogg",
  ".flac",
  ".m4a",
  ".mp4",
  ".webm",
]);
const DISCORD_ATTACHMENT_BASENAMES = new Set(["dockerfile"]);
const INCOMING_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;
const execFile = promisify(execFileCallback);

export interface DiscordBotHandlers {
  isCodexBusy(): boolean;
  onUserMessage(
    input: string,
    context: {
      requestId: string;
      source: "discord_message" | "discord_voice_channel";
      message?: Message;
      userId?: string;
    },
    stream: CodexTurnStreamHandlers | undefined,
    mode: CodexUserMessageMode,
  ): Promise<
    | { kind: "response"; turnId: string; result: CodexTurnResult }
    | { kind: "steering"; turnId: string; activeTurnId: string }
  >;
  onRestartRequested(context: {
    requestId: string;
    source: "discord_message" | "discord_voice_channel";
    message?: Message;
    userId?: string;
  }): Promise<void>;
}

type SendableTextChannel = {
  sendTyping: () => Promise<unknown>;
  send: (options: string | MessageCreateOptions) => Promise<unknown>;
};

type DeletableMessageLike = {
  delete: () => Promise<unknown>;
};

type EditableMessageLike = {
  edit: (options: string | MessageCreateOptions) => Promise<unknown>;
};

type CodexProgressMirrorState = {
  latestContent: string;
  message: EditableMessageLike | null;
};

type ReplayableTextChannel = TextBasedChannel & {
  messages: {
    fetch: (options: { limit: number; after: string }) => Promise<Collection<string, Message>>;
  };
};

type UserInputContext = {
  requestId: string;
  source: "discord_message" | "discord_voice_channel";
  message?: Message;
  userId?: string;
};

export class DiscordBridgeBot {
  private readonly client: Client;
  private readonly threadStore: CodexThreadStore;
  private readonly transcriber: LocalWhisperTranscriber;
  private voiceConnection: VoiceConnectionLike | null = null;
  private voiceModule: LoadedDiscordVoiceModule | null = null;
  private voiceStateLoggerAttached = false;
  private voicePlaybackChain: Promise<void> = Promise.resolve();
  private currentVoicePlayer: AudioPlayerLike | null = null;
  private currentVoiceLabel: string | null = null;
  private voicePlaybackGeneration = 0;
  private nextReasoningSpeechJobId = 1;
  private activeReasoningSpeechJob: ReasoningSpeechJob | null = null;
  private deferredReasoningSpeech: { text: string; label: string } | null = null;
  private activeVoiceRenderCount = 0;
  private readonly workingSfxSuppressionKeys = new Set<string>();
  private activeCodexTurns = 0;
  private stopWorkingSfxLoop: (() => void) | null = null;
  private lastSpeechPlaybackEndedAt = 0;
  private lastVoicePlaybackInterruptedAt = 0;
  private readonly activeVoiceCaptures = new Set<string>();
  private readonly codexProgressMirrors = new Map<string, CodexProgressMirrorState>();
  private startupAnnouncementMessage: string | null = null;
  private shutdownAnnouncementMessage: string | null = null;
  private startupAnnouncementText: string | null = null;
  private shutdownAnnouncementText: string | null = null;
  private voiceConnectionGeneration = 0;
  private voiceReconnectTimer: NodeJS.Timeout | null = null;
  private voiceReconnectInFlight = false;
  private voiceStateTransitionTimestamps: number[] = [];
  private voiceReconnectAttemptTimestamps: number[] = [];
  private lastProcessedDiscordMessageId: string | null = null;
  private readonly processingDiscordMessageIds = new Set<string>();
  private shuttingDown = false;

  constructor(
    private readonly config: AppConfig,
    private readonly handlers: DiscordBotHandlers,
    private readonly logger: Logger,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });
    this.threadStore = new CodexThreadStore(config.codexThreadMapPath);
    this.transcriber = new LocalWhisperTranscriber(config, logger);
  }

  async start(): Promise<void> {
    this.client.once(Events.ClientReady, async () => {
      try {
        this.logger.info(`Discord bot ready as ${this.client.user?.tag ?? "unknown"}`);
        await this.loadProcessingCheckpoint();
        await this.assertChannelAccessAndAnnounce();
        await this.ensureRestartCommand();
        await this.joinConfiguredVoiceChannel();
        const replayed = await this.catchUpMissedMessages();
        if (replayed === 0) {
          await this.resumeInterruptedWork();
        }
      } catch (error) {
        this.logger.error("Discord ready handler failed", error);
      }
    });

    this.client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message).catch((error) => {
        this.logger.error("Unhandled Discord message handler failure", error);
      });
    });
    this.client.on(Events.MessageReactionAdd, (reaction, user) => {
      void this.handleReaction(reaction, user).catch((error) => {
        this.logger.error("Unhandled Discord reaction handler failure", error);
      });
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.handleInteraction(interaction).catch((error) => {
        this.logger.error("Unhandled Discord interaction failure", error);
      });
    });
    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      const botUserId = this.client.user?.id;
      if (!botUserId) {
        return;
      }

      if (newState.id !== botUserId && oldState.id !== botUserId) {
        return;
      }

      this.logger.info("Discord bot voice state updated", {
        guildId: newState.guild.id,
        oldChannelId: oldState.channelId ?? null,
        newChannelId: newState.channelId ?? null,
        oldSessionId: oldState.sessionId ?? null,
        newSessionId: newState.sessionId ?? null,
        oldServerMute: oldState.serverMute,
        newServerMute: newState.serverMute,
        oldSelfMute: oldState.selfMute,
        newSelfMute: newState.selfMute,
        oldSuppress: oldState.suppress,
        newSuppress: newState.suppress,
      });
    });

    await this.client.login(this.config.discordBotToken);
  }

  reloadMessageConfig(
    config: Pick<
      AppConfig,
      | "discordStartupSfx"
      | "discordShutdownSfx"
      | "discordWorkingSfx"
      | "discordStartupMessages"
      | "discordShutdownMessages"
      | "discordVoiceListeningMessages"
      | "discordVoiceCapturedMessages"
      | "discordVoiceProcessingMessages"
      | "discordVoiceRejectedMessages"
      | "discordVoiceStoppedMessages"
      | "discordCodexWorkingMessages"
      | "discordCodexStartMessages"
      | "discordCodexReasoningMessages"
      | "discordCodexToolMessages"
      | "discordCodexPlanMessages"
    >,
  ): void {
    this.config.discordStartupSfx = [...config.discordStartupSfx];
    this.config.discordShutdownSfx = [...config.discordShutdownSfx];
    this.config.discordWorkingSfx = [...config.discordWorkingSfx];
    this.config.discordStartupMessages = [...config.discordStartupMessages];
    this.config.discordShutdownMessages = [...config.discordShutdownMessages];
    this.config.discordVoiceListeningMessages = [...config.discordVoiceListeningMessages];
    this.config.discordVoiceCapturedMessages = [...config.discordVoiceCapturedMessages];
    this.config.discordVoiceProcessingMessages = [...config.discordVoiceProcessingMessages];
    this.config.discordVoiceRejectedMessages = [...config.discordVoiceRejectedMessages];
    this.config.discordVoiceStoppedMessages = [...config.discordVoiceStoppedMessages];
    this.config.discordCodexWorkingMessages = [...config.discordCodexWorkingMessages];
    this.config.discordCodexStartMessages = [...config.discordCodexStartMessages];
    this.config.discordCodexReasoningMessages = [...config.discordCodexReasoningMessages];
    this.config.discordCodexToolMessages = [...config.discordCodexToolMessages];
    this.config.discordCodexPlanMessages = [...config.discordCodexPlanMessages];
    this.startupAnnouncementMessage = null;
    this.shutdownAnnouncementMessage = null;
    this.startupAnnouncementText = null;
    this.shutdownAnnouncementText = null;
    this.logger.info("Reloaded Discord message config", {
      startupSfx: this.config.discordStartupSfx.length,
      shutdownSfx: this.config.discordShutdownSfx.length,
      workingSfx: this.config.discordWorkingSfx.length,
      startupMessages: this.config.discordStartupMessages.length,
      shutdownMessages: this.config.discordShutdownMessages.length,
    });
  }

  async stop(options?: { announceText?: boolean }): Promise<void> {
    this.shuttingDown = true;
    this.activeCodexTurns = 0;
    this.clearVoiceReconnectTimer();
    this.stopWorkingSfxLoop?.();
    this.interruptVoicePlayback("shutdown");
    const shutdownMessage = this.shutdownAnnouncementMessage ?? pickRandom(this.config.discordShutdownMessages) ?? null;
    const shutdownText = this.shutdownAnnouncementText ?? this.getShutdownAnnouncementText();
    if (shutdownMessage || shutdownText) {
      const shutdownDeadlineMs = Date.now() + SHUTDOWN_VOICE_DRAIN_MS;
      let shutdownNotice: DeletableMessageLike | null = null;
      if (options?.announceText) {
        const channel = await this.getConfiguredTextChannel();
        shutdownNotice = (await channel.send({
          content: this.buildShutdownAnnouncementContent(shutdownText ?? "Shutting down.", shutdownDeadlineMs),
        })) as DeletableMessageLike;
      }
      if (shutdownMessage) {
        await this.playVoiceCue(
          shutdownMessage,
          {
            label: "shutdown",
            guildName: this.getCurrentVoiceGuildName(),
            channelName: this.getCurrentVoiceChannelName(),
          },
          pickRandom(this.config.discordShutdownSfx),
        );
      }
      const remainingMs = Math.max(0, shutdownDeadlineMs - Date.now());
      if (remainingMs > 0) {
        await sleep(remainingMs);
      }
      await shutdownNotice?.delete().catch(() => undefined);
    }
    this.destroyVoiceConnection("shutdown");
    await this.client.destroy();
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  prepareShutdownAnnouncement(): string | null {
    if (!this.shutdownAnnouncementMessage) {
      this.shutdownAnnouncementMessage = pickRandom(this.config.discordShutdownMessages) ?? null;
    }
    if (!this.shutdownAnnouncementText) {
      this.shutdownAnnouncementText = this.getShutdownAnnouncementText();
    }

    return this.shutdownAnnouncementMessage;
  }

  private buildShutdownAnnouncementContent(content: string, shutdownAtMs: number): string {
    const shutdownAtUnixSeconds = Math.floor(shutdownAtMs / 1000);
    return `${content} Znikam <t:${shutdownAtUnixSeconds}:R>.`;
  }

  async announce(content: string, options?: { speak?: boolean }): Promise<void> {
    const channel = await this.getConfiguredTextChannel();
    await channel.send({
      content,
    });
    if (options?.speak !== false) {
      void this.enqueueVoiceSpeech(content, "announce");
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) {
      return;
    }

    if (message.channelId !== this.config.discordChannelId) {
      return;
    }

    if (this.shuttingDown) {
      return;
    }

    if (this.isMessageAlreadyProcessed(message.id)) {
      this.logger.debug(`Skipping already processed Discord message ${message.id}`);
      return;
    }

    if (this.processingDiscordMessageIds.has(message.id)) {
      this.logger.debug(`Skipping already inflight Discord message ${message.id}`);
      return;
    }

    if (!message.content.trim() && !this.hasVoiceMessage(message) && !this.hasIncomingAttachments(message)) {
      return;
    }

    this.processingDiscordMessageIds.add(message.id);
    try {
      this.logger.info(`Received Discord message from ${message.author.tag}`);
      const input = await this.resolveMessageInput(message);
      this.logger.info(`Resolved Discord input for ${message.id}`, {
        input,
        source: this.describeIncomingMessageSource(message),
      });
      await this.processInput(
        {
          requestId: message.id,
          source: "discord_message",
          message,
        },
        input,
      );
      await this.markDiscordMessageProcessed(message.id);
    } finally {
      this.processingDiscordMessageIds.delete(message.id);
    }
  }

  private async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    if (user.bot || this.shuttingDown) {
      return;
    }

    if (reaction.partial) {
      await reaction.fetch();
    }

    const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    if (message.channelId !== this.config.discordChannelId) {
      return;
    }

    const botUserId = this.client.user?.id;
    if (!botUserId || message.author?.id !== botUserId) {
      return;
    }

    const input = await this.mapReactionToInput(reaction, message);
    if (!input) {
      return;
    }

    this.logger.info(`Received Discord reaction from ${user.tag}`, {
      messageId: message.id,
      emoji: reaction.emoji.name,
      input,
    });

    await this.processInput(
      {
        requestId: message.id,
        source: "discord_message",
        message,
      },
      input,
    );
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName !== "restart") {
      return;
    }

    if (interaction.channelId !== this.config.discordChannelId) {
      await interaction.reply({
        content: "Use this command in the configured bridge channel.",
        ephemeral: true,
      });
      return;
    }

    this.logger.info("Received /restart command", {
      userId: interaction.user.id,
      channelId: interaction.channelId,
    });

    await this.replyToRestartInteraction(interaction);
    await this.handlers.onRestartRequested({
      requestId: interaction.id,
      source: "discord_message",
      userId: interaction.user.id,
    });
  }

  private async processInput(context: UserInputContext, input: string): Promise<void> {
    const normalizedCommand = normalizeVoiceCommandText(input);
    if (isRestartCommand(normalizedCommand)) {
      this.logger.info(`Received restart command from ${context.source}`, {
        requestId: context.requestId,
        userId: context.userId ?? context.message?.author.id ?? null,
      });
      await this.persistRestartCheckpoint(context);
      await this.sendAdministrativeResponse(context, "Restarting.");
      await this.handlers.onRestartRequested(context);
      return;
    }

    if (this.handlers.isCodexBusy()) {
      try {
        const dispatch = await this.handlers.onUserMessage(input, context, undefined, "steering");
        if (dispatch.kind === "steering") {
          this.logger.info("Forwarded Discord input as steering for an active Codex turn", {
            requestId: context.requestId,
            source: context.source,
            turnId: dispatch.turnId,
            activeTurnId: dispatch.activeTurnId,
          });
          return;
        }

        this.logger.info("Steering fallback produced a standalone Codex turn; sending its final response", {
          requestId: context.requestId,
          source: context.source,
          turnId: dispatch.turnId,
        });
        await this.sendResponse(context, new DiscordMessageStream(), dispatch.result);
      } catch (error) {
        if (this.isShutdownError(error)) {
          this.logger.info("Skipping Discord steering reply because the bridge is shutting down");
          return;
        }
        if (this.isSuppressedAttachedHintError(error)) {
          this.logger.info("Suppressing steering error for an attached hint", {
            requestId: context.requestId,
            source: context.source,
          });
          return;
        }

        this.logger.error("Failed to process Discord steering message", error);
      }
      return;
    }

    const stream = new DiscordMessageStream();
    const targetChannel = context.message
      ? (context.message.channel as SendableTextChannel)
      : await this.getConfiguredTextChannel();
    const typingIndicator = new DiscordTypingIndicator(targetChannel);
    let lastWorkingSpeechAt = 0;
    let lastInformativeSpeechAt = 0;
    let lastInformativeSpeechText = "";
    let hasSeenSummary = false;
    let lastProgressGroup: "start" | "reasoning" | "tool" | "plan" | "working" | null = null;
    const finishCodexActivity = this.beginCodexActivity();
    let codexActivityFinished = false;

    const stopCodexActivity = (): void => {
      if (codexActivityFinished) {
        return;
      }

      codexActivityFinished = true;
      this.setWorkingSfxSuppressed(context.requestId, false);
      finishCodexActivity();
    };

    const beginSummaryPhase = (): void => {
      if (hasSeenSummary) {
        return;
      }

      hasSeenSummary = true;
      typingIndicator.stop();
      this.interruptVoicePlayback("codex_summary_started");
      stopCodexActivity();
    };

    const maybeSpeakProgressMessage = (
      group: "start" | "reasoning" | "tool" | "plan" | "working" = "working",
      headline?: string,
      detail?: string,
      detailFormat: CodexProgressDetailFormat = "code",
      informative = false,
    ): void => {
      const now = Date.now();
      const trimmedHeadline = headline?.trim();
      const trimmedDetail = detail?.trim();
      const enteringStart = group === "start" && lastProgressGroup !== "start";
      if (enteringStart) {
        this.interruptVoicePlayback("codex_start_started");
      }
      this.setWorkingSfxSuppressed(context.requestId, false);
      lastProgressGroup = group;
      const fallbackMessage = pickRandom(this.getCodexProgressMessages(group));
      const spokenMessage = selectSpokenCodexProgressMessage(
        group,
        trimmedHeadline,
        trimmedDetail,
        detailFormat,
        fallbackMessage,
        informative,
      );
      const mirrorMessage = formatCodexProgressMirrorMessage(
        group,
        trimmedHeadline,
        trimmedDetail,
        detailFormat,
        fallbackMessage,
        informative,
      );
      if (!spokenMessage && !mirrorMessage) {
        return;
      }

      if (spokenMessage && informative) {
        const informativeThrottleMs =
          group === "reasoning" ? CODEX_REASONING_SPEECH_THROTTLE_MS : CODEX_INFORMATIVE_SPEECH_THROTTLE_MS;
        if (
          spokenMessage === lastInformativeSpeechText &&
          now - lastInformativeSpeechAt < CODEX_WORKING_SPEECH_THROTTLE_MS
        ) {
          return;
        }

        if (now - lastInformativeSpeechAt < informativeThrottleMs) {
          return;
        }

        lastInformativeSpeechAt = now;
        lastInformativeSpeechText = spokenMessage ?? "";
      } else if (spokenMessage) {
        if (now - lastWorkingSpeechAt < CODEX_WORKING_SPEECH_THROTTLE_MS) {
          return;
        }
        lastWorkingSpeechAt = now;
      }

      if (spokenMessage) {
        if (group === "reasoning") {
          void this.enqueueReasoningVoiceSpeech(spokenMessage, `codex_${group}`);
        } else {
          void this.enqueueVoiceVariant(spokenMessage, `codex_${group}`);
        }
      }
      if (mirrorMessage) {
        void this.updateCodexProgressMirror(context, mirrorMessage);
      }
    };

    try {
      await typingIndicator.start();
      const dispatch = await this.handlers.onUserMessage(input, context, {
        onProgressEvent: async ({ group, headline, detail, detailFormat, informative }: CodexProgressEvent) => {
          if (hasSeenSummary) {
            return;
          }
          maybeSpeakProgressMessage(group, headline, detail, detailFormat, informative);
        },
        onSummaryDelta: async (delta) => {
          beginSummaryPhase();
          await stream.appendSummary(delta);
          await this.updateCodexProgressMirror(context, stream.getLiveSummaryContent());
        },
        onSummaryPartAdded: async () => {
          beginSummaryPhase();
          await stream.appendSummaryBreak();
          await this.updateCodexProgressMirror(context, stream.getLiveSummaryContent());
        },
      }, "interactive");
      typingIndicator.stop();
      stopCodexActivity();
      if (dispatch.kind !== "response") {
        this.logger.info("Codex accepted an interactive Discord input as steering; skipping standalone reply", {
          requestId: context.requestId,
          source: context.source,
          turnId: dispatch.turnId,
          activeTurnId: dispatch.activeTurnId,
        });
        return;
      }

      await this.sendResponse(context, stream, dispatch.result);
    } catch (error) {
      typingIndicator.stop();
      stopCodexActivity();
      if (this.isShutdownError(error)) {
        this.logger.info("Skipping Discord reply because the bridge is shutting down");
        return;
      }
      if (this.isSuppressedAttachedHintError(error)) {
        this.logger.info("Skipping Discord failure reply for an attached hint after the main turn timed out", {
          requestId: context.requestId,
          source: context.source,
        });
        return;
      }

      this.logger.error("Failed to process Discord message", error);
      try {
        await this.sendFailureResponse(context, this.formatBridgeError(error));
      } catch (replyError) {
        this.logger.error("Failed to send Discord failure response", replyError);
      }
    }
  }

  private async assertChannelAccessAndAnnounce(): Promise<void> {
    const textChannel = await this.getConfiguredTextChannel();
    await textChannel.sendTyping();
    const startupText = this.startupAnnouncementText ?? this.getStartupAnnouncementText();
    this.startupAnnouncementText = startupText;
    if (!this.startupAnnouncementMessage && startupText) {
      this.startupAnnouncementMessage = startupText;
    }
    if (startupText) {
      await this.announce(startupText, { speak: false });
    }
  }

  private async ensureRestartCommand(): Promise<void> {
    const channel = await this.getConfiguredTextChannel();
    const guild = ("guild" in channel ? channel.guild : null) as Guild | null;
    if (!guild) {
      return;
    }

    const commands = await guild.commands.fetch().catch(() => null);
    const existing = commands?.find((command) => command.name === "restart");
    if (existing) {
      return;
    }

    await guild.commands.create({
      name: "restart",
      description: "Restartuje bridge Codex-Discord.",
    });
    this.logger.info(`Registered /restart command in guild ${guild.id}`);
  }

  private async loadProcessingCheckpoint(): Promise<void> {
    const record = await this.threadStore.get(this.config.discordChannelId);
    this.lastProcessedDiscordMessageId = record?.lastProcessedDiscordMessageId ?? null;
    if (this.lastProcessedDiscordMessageId) {
      this.logger.info(`Loaded Discord checkpoint ${this.lastProcessedDiscordMessageId}`);
    }
  }

  private async catchUpMissedMessages(): Promise<number> {
    if (!this.lastProcessedDiscordMessageId) {
      return 0;
    }

    const channel = await this.getConfiguredReplayChannel();

    let after = this.lastProcessedDiscordMessageId;
    let replayed = 0;

    while (!this.shuttingDown) {
      const batch = await channel.messages.fetch({
        limit: 100,
        after,
      });

      if (batch.size === 0) {
        break;
      }

      const messages = [...batch.values()]
        .filter((message) => !message.author.bot)
        .sort((left, right) => compareDiscordIds(left.id, right.id));

      if (messages.length === 0) {
        after = [...batch.keys()].sort(compareDiscordIds).at(-1) ?? after;
        continue;
      }

      for (const message of messages) {
        if (this.shuttingDown || this.isMessageAlreadyProcessed(message.id)) {
          continue;
        }

        if (this.shouldIgnoreReplayMessage(message)) {
          this.logger.info(`Ignoring replayed restart command ${message.id}`);
          await this.markDiscordMessageProcessed(message.id);
          replayed += 1;
          continue;
        }

        this.logger.info(`Replaying missed Discord message ${message.id}`);
        await this.handleMessage(message);
        replayed += 1;
      }

      after = messages.at(-1)?.id ?? after;
    }

    if (replayed > 0) {
      this.logger.info(`Replayed ${replayed} missed Discord messages`);
    }

    return replayed;
  }

  private isMessageAlreadyProcessed(messageId: string): boolean {
    if (!this.lastProcessedDiscordMessageId) {
      return false;
    }

    return compareDiscordIds(messageId, this.lastProcessedDiscordMessageId) <= 0;
  }

  private async markDiscordMessageProcessed(messageId: string): Promise<void> {
    if (this.isMessageAlreadyProcessed(messageId)) {
      return;
    }

    this.lastProcessedDiscordMessageId = messageId;
    await this.threadStore.setLastProcessedDiscordMessageId(this.config.discordChannelId, messageId);
  }

  private async persistRestartCheckpoint(context: UserInputContext): Promise<void> {
    const messageId = context.message?.id;
    if (!messageId) {
      return;
    }

    try {
      await this.markDiscordMessageProcessed(messageId);
    } catch (error) {
      this.logger.warn(`Failed to persist restart checkpoint for ${messageId}`, error);
    }
  }

  private shouldIgnoreReplayMessage(message: Message): boolean {
    const normalizedContent = normalizeVoiceCommandText(message.content);
    return Boolean(normalizedContent) && isRestartCommand(normalizedContent);
  }

  private async resumeInterruptedWork(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    const prompt = "Is the last feature finished? If not, continue working.";
    this.logger.info("Sending startup resume prompt to Codex");
    await this.processInput(
      {
        requestId: `startup_resume:${Date.now()}`,
        source: "discord_message",
      },
      prompt,
    );
  }

  private async sendResponse(
    context: UserInputContext,
    stream: DiscordMessageStream,
    result: CodexTurnResult,
  ): Promise<void> {
    const progressMessage = this.takeCodexProgressMirror(context.requestId);
    const usageEmbed = this.buildTokenUsageEmbed(result.tokenUsage, result.accountRateLimits);
    const finalContent = stream.getFinalContent(result.response || "(empty response)");
    const segments = chunkMessage(finalContent);
    const attachments = await this.resolveDiscordAttachments(result.attachments, finalContent);
    let startIndex = 0;

    if (progressMessage) {
      const firstContent = segments[0] ?? "(empty response)";
      await this.editResponseMessage(progressMessage, {
        content: firstContent,
        embeds: segments.length === 1 && usageEmbed ? [usageEmbed] : [],
        files: segments.length === 1 ? attachments : [],
      });
      startIndex = 1;
    }

    for (const [index, content] of segments.entries()) {
      if (index < startIndex) {
        continue;
      }
      const isLast = index === segments.length - 1;
      await this.sendResponseMessage(context, {
        content,
        embeds: isLast && usageEmbed ? [usageEmbed] : [],
        files: isLast ? attachments : [],
      });
    }

    void this.enqueueVoiceSpeech(finalContent, "response");
  }

  private async resolveDiscordAttachments(rawPaths: string[], content: string): Promise<string[]> {
    const candidates = new Set<string>(rawPaths);
    for (const referencedPath of this.extractExplicitDiscordAttachmentPaths(content)) {
      candidates.add(referencedPath);
    }

    const resolved: string[] = [];
    for (const candidate of candidates) {
      if (resolved.length >= DISCORD_MAX_ATTACHMENTS) {
        break;
      }

      const normalized = candidate.trim();
      if (!normalized) {
        continue;
      }

      const absolutePath = path.isAbsolute(normalized)
        ? normalized
        : path.resolve(this.config.codexCwd, normalized);
      if (!isAllowedDiscordAttachmentPath(absolutePath)) {
        continue;
      }

      try {
        const fileStat = await stat(absolutePath);
        if (!fileStat.isFile()) {
          continue;
        }
        if (fileStat.size > DISCORD_ATTACHMENT_MAX_BYTES) {
          this.logger.warn(`Skipping Discord attachment larger than ${DISCORD_ATTACHMENT_MAX_BYTES} bytes`, {
            path: absolutePath,
            size: fileStat.size,
          });
          continue;
        }
        resolved.push(absolutePath);
      } catch {
        continue;
      }
    }

    return resolved;
  }

  private extractExplicitDiscordAttachmentPaths(content: string): string[] {
    const blocks = [...content.matchAll(/\[(?:discord attachments|zalaczniki do discorda)\]\s*([\s\S]*?)(?:\n\s*\n|$)/gi)];
    if (blocks.length === 0) {
      return [];
    }

    const paths: string[] = [];
    for (const [, block = ""] of blocks) {
      for (const rawLine of block.split("\n")) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        const normalizedLine = line.replace(/^[-*]\s+/, "").replaceAll("`", "").trim();
        if (!normalizedLine) {
          continue;
        }

        if (!/^(?:\.{1,2}\/|\/)/.test(normalizedLine)) {
          continue;
        }

        if (!isAllowedDiscordAttachmentPath(normalizedLine)) {
          continue;
        }

        paths.push(normalizedLine);
      }
    }

    return paths;
  }

  private async sendFailureResponse(context: UserInputContext, content: string): Promise<void> {
    const progressMessage = this.takeCodexProgressMirror(context.requestId);
    if (progressMessage) {
      await this.editResponseMessage(progressMessage, { content });
    } else {
      await this.sendResponseMessage(context, { content });
    }
    void this.enqueueVoiceSpeech(content, "failure");
  }

  private async sendAdministrativeResponse(context: UserInputContext, content: string): Promise<void> {
    const progressMessage = this.takeCodexProgressMirror(context.requestId);
    if (progressMessage) {
      await this.editResponseMessage(progressMessage, { content });
    } else {
      await this.sendResponseMessage(context, { content });
    }

    void this.enqueueVoiceSpeech(content, "admin");
  }

  private async replyToRestartInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply({
      content: "Restarting.",
    });

    void this.enqueueVoiceSpeech("Restarting.", "admin");
  }

  private buildTokenUsageEmbed(
    tokenUsage: ThreadTokenUsage | null,
    accountRateLimits: AccountRateLimitSnapshot | null,
  ): EmbedBuilder | null {
    if (!tokenUsage) {
      return null;
    }

    const lastTokens = tokenUsage.last.totalTokens;
    const usageLimits = this.formatUsageLimits(accountRateLimits);
    const footerText = [`📦 ${this.getProjectLabel()}`, `🪙 ${this.formatTokenCount(lastTokens)}`, usageLimits]
      .filter(Boolean)
      .join(" • ");

    return new EmbedBuilder().setFooter({ text: footerText });
  }

  private formatUsageLimits(accountRateLimits: AccountRateLimitSnapshot | null): string {
    if (!accountRateLimits) {
      return "";
    }

    const windows = [accountRateLimits.primary, accountRateLimits.secondary].filter(
      (window): window is AccountRateLimitWindow => Boolean(window),
    );

    const fiveHour = windows.find((window) => window.windowDurationMins === 5 * 60);
    const sevenDay = windows.find((window) => window.windowDurationMins === 7 * 24 * 60);

    return [
      fiveHour ? `5h ${this.formatPercent(windowAvailable(fiveHour))}` : "",
      sevenDay
        ? `${this.formatRateLimitResetDate(sevenDay.resetsAt) ?? "7d"} ${this.formatPercent(windowAvailable(sevenDay))}`
        : "",
    ]
      .filter(Boolean)
      .join(" • ");
  }

  private getProjectLabel(): string {
    return PROJECT_INFO.name;
  }

  private formatNumber(value: number): string {
    return new Intl.NumberFormat("pl-PL").format(value);
  }

  private formatTokenCount(value: number): string {
    if (value < 1000) {
      return value.toFixed(0);
    }

    return `${(value / 1000).toFixed(1)}k`;
  }

  private formatPercent(value: number): string {
    return `${value.toFixed(0)}%`;
  }

  private formatRateLimitResetDate(resetsAt: number | null): string | null {
    if (!Number.isFinite(resetsAt)) {
      return null;
    }

    const timestampMs = resetsAt! < 1_000_000_000_000 ? resetsAt! * 1000 : resetsAt!;
    const date = new Date(timestampMs);
    if (Number.isNaN(date.getTime())) {
      return null;
    }

    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(date);
  }

  private formatBridgeError(error: unknown): string {
    const fallback = "Bridge error: failed to get a response from Codex.";
    if (!(error instanceof Error)) {
      return fallback;
    }

    const message = error.message.trim();
    if (!message) {
      return fallback;
    }

    return `Bridge error: ${message}`;
  }

  private isShutdownError(error: unknown): boolean {
    return error instanceof Error && error.message.trim() === "Codex session shut down";
  }

  private isSuppressedAttachedHintError(error: unknown): boolean {
    return error instanceof CodexAttachedHintTurnCancelledError || error instanceof CodexSecondaryTurnCancelledError;
  }

  private async resolveMessageInput(message: Message): Promise<string> {
    const content = message.content.trim();
    let baseInput = content;

    if (this.hasVoiceMessage(message)) {
      const voiceAttachment = this.findVoiceAttachment(message.attachments);
      if (!voiceAttachment) {
        return content;
      }

      const startedAt = performance.now();
      this.logger.info(`Voice message detected for ${message.id}`, {
        name: voiceAttachment.name,
        contentType: voiceAttachment.contentType,
        durationSeconds: voiceAttachment.duration,
        sizeBytes: voiceAttachment.size,
      });

      const transcript = await this.transcriber.transcribeAttachment(voiceAttachment);
      const elapsedMs = Math.round(performance.now() - startedAt);

      this.logger.info(`Voice message transcribed for ${message.id}`, {
        elapsedMs,
        transcript,
      });

      await this.sendTranscriptReceipt(message, transcript);

      baseInput = content ? `${content}\n\n[voice transcript]\n${transcript}` : transcript;
    }

    const savedAttachments = await this.saveIncomingAttachments(message);
    if (savedAttachments.length > 0) {
      const attachmentBlock = buildAttachmentInput(savedAttachments);
      baseInput = baseInput ? `${baseInput}\n\n${attachmentBlock}` : attachmentBlock;
    }

    const referencedMessage = await this.resolveReferencedMessage(message);
    if (!referencedMessage) {
      return baseInput;
    }

    const referencedAttachments = await this.saveIncomingAttachments(referencedMessage);
    return buildReplyInput(referencedMessage, baseInput, referencedAttachments);
  }

  private async sendTranscriptReceipt(message: Message, transcript: string): Promise<void> {
    const content = `Otrzymano: ${transcript}`;
    await message.reply({
      content,
      allowedMentions: {
        repliedUser: false,
      },
    });
    void this.enqueueVoiceSpeech(content, "transcript_receipt");
  }

  private async sendVoiceChannelTranscriptReceipt(userId: string, transcript: string): Promise<void> {
    const channel = await this.getConfiguredTextChannel();
    await channel.send({
      content: `Heard from <@${userId}>: ${transcript}`,
    });
  }

  private hasVoiceMessage(message: Message): boolean {
    return message.flags.has("IsVoiceMessage");
  }

  private hasIncomingAttachments(message: Message): boolean {
    const voiceAttachmentId = this.findVoiceAttachment(message.attachments)?.id ?? null;
    return [...message.attachments.keys()].some((attachmentId) => attachmentId !== voiceAttachmentId);
  }

  private describeIncomingMessageSource(message: Message): "text" | "voice_or_mixed" | "attachment_or_mixed" {
    if (this.hasVoiceMessage(message)) {
      return "voice_or_mixed";
    }

    if (this.hasIncomingAttachments(message)) {
      return "attachment_or_mixed";
    }

    return "text";
  }

  private async saveIncomingAttachments(message: Message): Promise<SavedIncomingAttachment[]> {
    if (message.attachments.size === 0) {
      return [];
    }

    const voiceAttachmentId = this.findVoiceAttachment(message.attachments)?.id ?? null;
    const attachments = [...message.attachments.values()].filter((attachment) => attachment.id !== voiceAttachmentId);
    if (attachments.length === 0) {
      return [];
    }

    const incomingDir = path.join(CODEX_DISCORD_INCOMING_DIR, message.id);
    await mkdir(incomingDir, { recursive: true });
    const saved: SavedIncomingAttachment[] = [];

    for (const attachment of attachments) {
      try {
        if (attachment.size > INCOMING_ATTACHMENT_MAX_BYTES) {
          this.logger.warn(`Skipping incoming attachment larger than ${INCOMING_ATTACHMENT_MAX_BYTES} bytes`, {
            messageId: message.id,
            name: attachment.name,
            sizeBytes: attachment.size,
          });
          continue;
        }

        const targetPath = await resolveIncomingAttachmentTargetPath(incomingDir, attachment);
        const existingFile = await readSavedIncomingAttachment(targetPath);
        if (existingFile) {
          saved.push({
            name: attachment.name || path.basename(targetPath),
            contentType: attachment.contentType ?? null,
            sizeBytes: existingFile.sizeBytes,
            path: targetPath,
          });
          continue;
        }

        const response = await fetch(attachment.url);
        if (!response.ok) {
          throw new Error(`Failed to download attachment: ${response.status} ${response.statusText}`);
        }

        const fileBuffer = Buffer.from(await response.arrayBuffer());
        await writeFile(targetPath, fileBuffer);

        saved.push({
          name: attachment.name || path.basename(targetPath),
          contentType: attachment.contentType ?? null,
          sizeBytes: fileBuffer.byteLength,
          path: targetPath,
        });
      } catch (error) {
        this.logger.warn(`Failed to persist incoming attachment ${attachment.name ?? attachment.id}`, error);
      }
    }

    return saved;
  }

  private async resolveReferencedMessage(message: Message): Promise<Message | null> {
    if (!message.reference?.messageId) {
      return null;
    }

    try {
      if (message.reference.channelId && message.reference.channelId !== message.channelId) {
        return null;
      }

      if (message.reference.messageId === message.id) {
        return null;
      }

      if (message.reference.guildId && message.reference.guildId !== message.guildId) {
        return null;
      }

      return await message.fetchReference();
    } catch (error) {
      this.logger.warn(`Failed to fetch referenced Discord message for ${message.id}`, error);
      return null;
    }
  }

  private async mapReactionToInput(
    reaction: MessageReaction | PartialMessageReaction,
    message: Message,
  ): Promise<string | null> {
    const emoji = reaction.emoji.name;
    if (!emoji) {
      return null;
    }

    const messageSummary = summarizeMessageContent(message);
    const messageAttachments = await this.saveIncomingAttachments(message);
    const attachmentContext = buildOptionalAttachmentContext(messageAttachments, "zalaczniki wiadomosci");

    switch (emoji) {
      case "👍":
        return withOptionalContext(`Reacting 👍 to the message: "${messageSummary}". OK.`, attachmentContext);
      case "👎":
        return withOptionalContext(
          `Reacting 👎 to the message: "${messageSummary}". No, that does not work for me.`,
          attachmentContext,
        );
      case "❤️":
      case "❤":
        return withOptionalContext(`Reacting ❤️ to the message: "${messageSummary}". I like that.`, attachmentContext);
      case "🔥":
        return withOptionalContext(
          `Reacting 🔥 to the message: "${messageSummary}". This is great, keep going in that direction.`,
          attachmentContext,
        );
      case "🙏":
        return withOptionalContext(`Reacting 🙏 to the message: "${messageSummary}". Thanks.`, attachmentContext);
      case "✅":
        return withOptionalContext(`Reacting ✅ to the message: "${messageSummary}". I approve this.`, attachmentContext);
      case "❌":
        return withOptionalContext(`Reacting ❌ to the message: "${messageSummary}". I reject this.`, attachmentContext);
      case "😂":
      case "😄":
      case "😆":
      case "😁":
      case "😀":
      case "🤣":
        return withOptionalContext(
          `Reacting ${emoji} to the message: "${messageSummary}". That made me laugh.`,
          attachmentContext,
        );
      default:
        return withOptionalContext(
          `I reacted with ${emoji} to the message: "${messageSummary}". Treat that as my short reply to it.`,
          attachmentContext,
        );
    }
  }

  private findVoiceAttachment(attachments: Collection<string, Attachment>): Attachment | null {
    for (const attachment of attachments.values()) {
      const contentType = attachment.contentType?.toLowerCase() ?? "";
      if (attachment.duration || attachment.waveform || contentType.startsWith("audio/")) {
        return attachment;
      }
    }

    return null;
  }

  private async getConfiguredTextChannel(): Promise<SendableTextChannel> {
    const channel = await this.client.channels.fetch(this.config.discordChannelId);
    if (!channel) {
      throw new Error(`Configured channel ${this.config.discordChannelId} was not found`);
    }

    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.PublicThread &&
      channel.type !== ChannelType.PrivateThread &&
      channel.type !== ChannelType.AnnouncementThread
    ) {
      throw new Error(`Configured channel ${this.config.discordChannelId} is not a text channel`);
    }

    return channel as TextBasedChannel as SendableTextChannel;
  }

  private async getConfiguredReplayChannel(): Promise<ReplayableTextChannel> {
    const channel = await this.client.channels.fetch(this.config.discordChannelId);
    if (!channel) {
      throw new Error(`Configured channel ${this.config.discordChannelId} was not found`);
    }

    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.PublicThread &&
      channel.type !== ChannelType.PrivateThread &&
      channel.type !== ChannelType.AnnouncementThread
    ) {
      throw new Error(`Configured channel ${this.config.discordChannelId} is not a text channel`);
    }

    return channel as ReplayableTextChannel;
  }

  private async joinConfiguredVoiceChannel(): Promise<void> {
    if (!this.config.discordVoiceChannelId || this.shuttingDown || this.voiceReconnectInFlight) {
      return;
    }

    this.voiceReconnectInFlight = true;
    try {
      this.clearVoiceReconnectTimer();
      this.logger.info(`Attempting to join Discord voice channel ${this.config.discordVoiceChannelId}`);

      const channel = await this.client.channels.fetch(this.config.discordVoiceChannelId);
      if (!channel) {
        throw new Error(`Configured voice channel ${this.config.discordVoiceChannelId} was not found`);
      }

      if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
        throw new Error(`Configured voice channel ${this.config.discordVoiceChannelId} is not a voice channel`);
      }

      const voice = await loadDiscordVoiceModule();
      if (!voice) {
        this.logger.warn("Skipping voice auto-join because @discordjs/voice is not installed");
        return;
      }
      this.voiceModule = voice;

      this.destroyVoiceConnection("rejoin");
      const generation = ++this.voiceConnectionGeneration;
      this.voiceConnection = voice.joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      this.logger.info(`Joined Discord voice channel transport ${channel.guild.name} / ${channel.name}`);

      this.attachVoiceConnectionStateMonitor(this.voiceConnection, {
        generation,
        guildId: channel.guild.id,
        channelId: channel.id,
      });

      this.logger.info("Discord voice connection snapshot", {
        guildId: channel.guild.id,
        channelId: channel.id,
        status: this.voiceConnection.state?.status ?? "unknown",
        endpoint: this.voiceConnection.state?.networking?.state?.endpoint ?? null,
        serverId: this.voiceConnection.state?.networking?.state?.serverId ?? null,
        code: this.voiceConnection.state?.networking?.state?.code ?? null,
      });

      try {
        await voice.entersState(this.voiceConnection, voice.VoiceConnectionStatus.Ready, 15_000);
        if (generation !== this.voiceConnectionGeneration || this.shuttingDown) {
          return;
        }

        this.voiceStateTransitionTimestamps = [];
        this.logger.info(`Joined Discord voice channel ${channel.guild.name} / ${channel.name}`);
        this.attachVoiceReceiver(channel.guild.id);
        const startupMessage =
          this.startupAnnouncementMessage ?? this.startupAnnouncementText ?? pickRandom(this.config.discordStartupMessages) ?? null;
        this.startupAnnouncementMessage = startupMessage;
        if (startupMessage) {
          await this.playVoiceCue(
            startupMessage,
            {
              label: "startup",
              guildName: channel.guild.name,
              channelName: channel.name,
            },
            pickRandom(this.config.discordStartupSfx),
          );
        }
      } catch (error) {
        if (generation !== this.voiceConnectionGeneration || this.shuttingDown || isAbortError(error)) {
          this.logger.info("Ignoring expected Discord voice ready abort", {
            guildId: channel.guild.id,
            channelId: channel.id,
            generation,
            reason: this.shuttingDown ? "shutdown" : generation !== this.voiceConnectionGeneration ? "stale_generation" : "abort",
          });
          return;
        }

        this.logger.warn(
          `Discord voice channel did not reach ready state in time for ${channel.guild.name} / ${channel.name}`,
          error,
        );
        this.scheduleVoiceReconnect("ready_timeout");
      }
    } finally {
      this.voiceReconnectInFlight = false;
    }
  }

  private getStartupAnnouncementText(): string | null {
    return pickRandomTextVariant(this.config.discordStartupMessages) ?? "Wracam.";
  }

  private getShutdownAnnouncementText(): string | null {
    return pickRandomTextVariant(this.config.discordShutdownMessages) ?? "Shutting down.";
  }

  private attachVoiceReceiver(guildId: string): void {
    const voice = this.voiceModule;
    const connection = this.voiceConnection;
    if (!voice || !connection) {
      return;
    }

    if (connection.receiver.__codexReceiverAttached) {
      return;
    }
    connection.receiver.__codexReceiverAttached = true;

    connection.receiver.speaking.on("start", (userId: string) => {
      void this.captureVoiceSegment(guildId, userId, voice).catch((error) => {
        this.logger.warn(`Failed to capture voice segment for ${userId}`, error);
      });
    });
  }

  private attachVoiceConnectionStateMonitor(
    connection: VoiceConnectionLike,
    context: { generation: number; guildId: string; channelId: string },
  ): void {
    connection.on?.("stateChange", (oldState, newState) => {
      if (context.generation !== this.voiceConnectionGeneration) {
        return;
      }

      const oldStatus = oldState.status ?? "unknown";
      const newStatus = newState.status ?? "unknown";
      this.logger.info("Discord voice connection state changed", {
        guildId: context.guildId,
        channelId: context.channelId,
        oldStatus,
        newStatus,
      });

      if (this.shuttingDown) {
        return;
      }

      if (newStatus === "ready") {
        this.voiceStateTransitionTimestamps = [];
        return;
      }

      if (newStatus === "destroyed") {
        this.scheduleVoiceReconnect("destroyed");
        return;
      }

      if (!["connecting", "signalling", "disconnected"].includes(newStatus)) {
        return;
      }

      const now = Date.now();
      this.voiceStateTransitionTimestamps = this.voiceStateTransitionTimestamps
        .filter((timestamp) => now - timestamp <= VOICE_STATE_FLAP_WINDOW_MS);
      this.voiceStateTransitionTimestamps.push(now);

      if (this.voiceStateTransitionTimestamps.length >= VOICE_STATE_FLAP_THRESHOLD) {
        this.logger.warn("Discord voice connection is flapping, scheduling a clean rejoin", {
          guildId: context.guildId,
          channelId: context.channelId,
          transitions: this.voiceStateTransitionTimestamps.length,
          windowMs: VOICE_STATE_FLAP_WINDOW_MS,
        });
        this.scheduleVoiceReconnect("state_flap");
      }
    });
  }

  private scheduleVoiceReconnect(reason: string): void {
    if (this.shuttingDown || this.voiceReconnectTimer || !this.config.discordVoiceChannelId) {
      return;
    }

    const now = Date.now();
    this.voiceReconnectAttemptTimestamps = this.voiceReconnectAttemptTimestamps
      .filter((timestamp) => now - timestamp <= VOICE_RECONNECT_COOLDOWN_MS);
    if (this.voiceReconnectAttemptTimestamps.length >= VOICE_RECONNECT_MAX_ATTEMPTS_PER_WINDOW) {
      this.logger.error("Discord voice reconnect circuit breaker opened", {
        reason,
        cooldownMs: VOICE_RECONNECT_COOLDOWN_MS,
        attempts: this.voiceReconnectAttemptTimestamps.length,
      });
      this.destroyVoiceConnection(`circuit_breaker:${reason}`);
      return;
    }

    this.voiceReconnectAttemptTimestamps.push(now);
    this.logger.warn(`Scheduling Discord voice reconnect (${reason})`, {
      delayMs: VOICE_RECONNECT_DELAY_MS,
    });
    this.destroyVoiceConnection(`reconnect:${reason}`);
    this.voiceReconnectTimer = setTimeout(() => {
      this.voiceReconnectTimer = null;
      if (this.shuttingDown) {
        return;
      }

      void this.joinConfiguredVoiceChannel().catch((error) => {
        this.logger.warn("Discord voice reconnect attempt failed", error);
        this.scheduleVoiceReconnect("reconnect_failed");
      });
    }, VOICE_RECONNECT_DELAY_MS);
  }

  private clearVoiceReconnectTimer(): void {
    if (!this.voiceReconnectTimer) {
      return;
    }

    clearTimeout(this.voiceReconnectTimer);
    this.voiceReconnectTimer = null;
  }

  private destroyVoiceConnection(reason: string): void {
    if (!this.voiceConnection) {
      return;
    }

    this.logger.info("Destroying Discord voice connection", { reason });
    this.voiceStateTransitionTimestamps = [];
    this.voiceConnectionGeneration += 1;
    this.voiceConnection.destroy();
    this.voiceConnection = null;
    this.voiceStateLoggerAttached = false;
  }

  private async captureVoiceSegment(guildId: string, userId: string, voice: LoadedDiscordVoiceModule): Promise<void> {
    if (!this.voiceConnection || this.shuttingDown) {
      return;
    }

    if (userId === this.client.user?.id || this.activeVoiceCaptures.has(userId)) {
      return;
    }

    const interruptedActivePlayback = Boolean(this.currentVoicePlayer);
    this.interruptVoicePlayback("user_speaking");
    this.activeVoiceCaptures.add(userId);
    const listeningMessage = pickRandom(this.config.discordVoiceListeningMessages);
    if (listeningMessage) {
      void this.enqueueVoiceVariant(listeningMessage, "voice_listening");
    }
    const startedAt = performance.now();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-recv-"));
    const pcmPath = path.join(tempDir, "segment.pcm");
    const wavPath = path.join(tempDir, "segment.wav");

    try {
      const opusStream = this.voiceConnection.receiver.subscribe(userId, {
        end: {
          behavior: voice.EndBehaviorType.AfterSilence,
          duration: VOICE_CAPTURE_AFTER_SILENCE_MS,
        },
      });

      const prismModule = await loadPrismMediaModule();
      if (!prismModule?.opus?.Decoder) {
        this.logger.warn("Skipping voice receive because prism-media opus decoder is unavailable");
        return;
      }

      const decoder = new prismModule.opus.Decoder({
        rate: 48_000,
        channels: 2,
        frameSize: 960,
      });

      this.logger.info("Started capturing Discord voice segment", {
        guildId,
        userId,
      });

      await pipeline(opusStream, decoder, createWriteStream(pcmPath));

      const elapsedMs = Math.round(performance.now() - startedAt);
      const pcmStats = await stat(pcmPath).catch(() => null);
      const pcmBytes = pcmStats?.size ?? 0;

      if (elapsedMs < VOICE_CAPTURE_MIN_DURATION_MS || pcmBytes === 0) {
        this.logger.info("Discarded Discord voice segment", {
          guildId,
          userId,
          reason: "too_short_or_empty",
          elapsedMs,
          pcmBytes,
          minDurationMs: VOICE_CAPTURE_MIN_DURATION_MS,
        });
        const rejectedMessage = pickRandom(this.config.discordVoiceRejectedMessages);
        if (rejectedMessage) {
          void this.enqueueVoiceVariant(rejectedMessage, "voice_rejected");
        }
        return;
      }

      const signal = await computePcmSignalMetrics(pcmPath);
      if (signal.rms < VOICE_CAPTURE_MIN_RMS || signal.activeRatio < VOICE_CAPTURE_MIN_ACTIVE_RATIO) {
        this.logger.info("Discarded Discord voice segment", {
          guildId,
          userId,
          reason: "low_signal",
          elapsedMs,
          pcmBytes,
          rms: Number(signal.rms.toFixed(4)),
          activeRatio: Number(signal.activeRatio.toFixed(3)),
          minRms: VOICE_CAPTURE_MIN_RMS,
          minActiveRatio: VOICE_CAPTURE_MIN_ACTIVE_RATIO,
        });
        const rejectedMessage = pickRandom(this.config.discordVoiceRejectedMessages);
        if (rejectedMessage) {
          void this.enqueueVoiceVariant(rejectedMessage, "voice_rejected");
        }
        return;
      }

      await execFile(this.config.ffmpegPath ?? "ffmpeg", [
        "-y",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-i",
        pcmPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        wavPath,
      ]);

      this.logger.info("Accepted Discord voice segment for transcription", {
        guildId,
        userId,
        elapsedMs,
        pcmBytes,
        rms: Number(signal.rms.toFixed(4)),
        activeRatio: Number(signal.activeRatio.toFixed(3)),
      });
      const capturedMessage = pickRandom(this.config.discordVoiceCapturedMessages);
      if (capturedMessage) {
        void this.enqueueVoiceVariant(capturedMessage, "voice_captured");
      }

      const transcript = await this.transcriber.transcribeAudioFile(wavPath, `voice-channel-${userId}.wav`);
      this.logger.info("Transcribed Discord voice segment", {
        guildId,
        userId,
        elapsedMs,
        rms: Number(signal.rms.toFixed(4)),
        activeRatio: Number(signal.activeRatio.toFixed(3)),
        transcript,
      });
      if ((interruptedActivePlayback || this.wasVoicePlaybackInterruptedRecently()) && isVoiceStopCommand(transcript)) {
        this.logger.info("Stopped Discord voice playback on user command", {
          guildId,
          userId,
          elapsedMs,
          transcript,
        });
        const stoppedMessage = pickRandom(this.config.discordVoiceStoppedMessages);
        if (stoppedMessage) {
          void this.enqueueVoiceVariant(stoppedMessage, "voice_stopped");
        }
        return;
      }
      const rejectedReason = classifyRejectedTranscript(transcript);
      if (rejectedReason) {
        this.logger.info("Rejected Discord voice transcript", {
          guildId,
          userId,
          elapsedMs,
          rms: Number(signal.rms.toFixed(4)),
          activeRatio: Number(signal.activeRatio.toFixed(3)),
          transcript,
          reason: rejectedReason,
        });
        const rejectedMessage = pickRandom(this.config.discordVoiceRejectedMessages);
        if (rejectedMessage) {
          void this.enqueueVoiceVariant(rejectedMessage, "voice_rejected");
        }
        return;
      }
      await this.sendVoiceChannelTranscriptReceipt(userId, transcript);
      const processingMessage = pickRandom(this.config.discordVoiceProcessingMessages);
      if (processingMessage) {
        void this.enqueueVoiceVariant(processingMessage, "voice_processing");
      }
      await this.processInput(
        {
          requestId: `voice:${userId}:${Date.now()}`,
          source: "discord_voice_channel",
          userId,
        },
        buildVoiceChannelInput(userId, transcript),
      );
    } finally {
      this.activeVoiceCaptures.delete(userId);
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private enqueueVoiceSpeech(text: string, label: string): Promise<void> {
    const normalizedText = normalizeSpeechText(text);
    if (!normalizedText) {
      return this.voicePlaybackChain;
    }
    const chunks = splitSpeechText(normalizedText, 1);
    if (chunks.length === 0) {
      return this.voicePlaybackChain;
    }

    const generation = this.voicePlaybackGeneration;

    this.voicePlaybackChain = this.voicePlaybackChain
      .catch(() => undefined)
      .then(async () => {
        if (generation !== this.voicePlaybackGeneration) {
          return;
        }

        const channelName = this.getCurrentVoiceChannelName();
        if (!channelName) {
          return;
        }

        const renderTasks: Array<Promise<RenderedVoiceSpeechChunk | null> | null> = new Array(chunks.length).fill(null);
        let nextToStart = 0;
        const disposePendingTasks = (): void => {
          for (const task of renderTasks) {
            if (!task) {
              continue;
            }

            void task
              .then(async (rendered) => {
                if (!rendered) {
                  return;
                }
                await this.disposeRenderedVoiceSpeechChunk(rendered);
              })
              .catch(() => undefined);
          }
        };

        const startNextRender = (): void => {
          if (nextToStart >= chunks.length) {
            return;
          }

          const index = nextToStart++;
          const chunk = chunks[index];
          if (!chunk) {
            return;
          }
          const chunkLabel = chunks.length === 1 ? label : `${label}_${index + 1}`;
          renderTasks[index] = this.renderVoiceSpeechChunk(chunk, {
            label: chunkLabel,
            guildName: this.getCurrentVoiceGuildName(),
            channelName,
          }).catch((error) => {
            this.logger.warn(`Failed to prerender Discord voice speech (${chunkLabel})`, error);
            return null;
          });
        };

        for (let index = 0; index < Math.min(VOICE_SPEECH_PRERENDER_CONCURRENCY, chunks.length); index += 1) {
          startNextRender();
        }

        for (let index = 0; index < chunks.length; index += 1) {
          if (generation !== this.voicePlaybackGeneration) {
            disposePendingTasks();
            return;
          }

          const task = renderTasks[index];
          if (!task) {
            continue;
          }

          const rendered = await task;
          renderTasks[index] = null;
          startNextRender();

          if (!rendered) {
            continue;
          }

          if (generation !== this.voicePlaybackGeneration) {
            await this.disposeRenderedVoiceSpeechChunk(rendered);
            disposePendingTasks();
            return;
          }

          try {
            await this.playVoiceWav(
              rendered.wavPath,
              {
                label: chunks.length === 1 ? label : `${label}_${index + 1}`,
                guildName: this.getCurrentVoiceGuildName(),
                channelName,
                interruptCurrent: true,
              },
              rendered.preview,
            );
          } finally {
            await this.disposeRenderedVoiceSpeechChunk(rendered);
          }
        }
      });

    return this.voicePlaybackChain;
  }

  private enqueueVoiceVariant(value: string, label: string): Promise<void> {
    const variant = value.trim();
    if (!variant) {
      return this.voicePlaybackChain;
    }

    const generation = this.voicePlaybackGeneration;
    this.voicePlaybackChain = this.voicePlaybackChain
      .catch(() => undefined)
      .then(async () => {
        if (generation !== this.voicePlaybackGeneration) {
          return;
        }

        const channelName = this.getCurrentVoiceChannelName();
        if (!channelName) {
          return;
        }

        await this.playVoiceVariant(
          variant,
          {
            label,
            guildName: this.getCurrentVoiceGuildName(),
            channelName,
          },
          { interruptCurrent: true },
        );
      });

    return this.voicePlaybackChain;
  }

  private enqueueReasoningVoiceSpeech(text: string, label: string): Promise<void> {
    const normalizedText = normalizeSpeechText(text);
    if (!normalizedText) {
      return this.voicePlaybackChain;
    }

    const now = Date.now();
    const activeJob = this.activeReasoningSpeechJob;
    if (activeJob) {
      if (shouldSupersedeReasoningSpeech(activeJob, now)) {
        this.cancelReasoningSpeechJob(activeJob, "reasoning_superseded");
        this.deferredReasoningSpeech = null;
      } else {
        this.deferredReasoningSpeech = { text: normalizedText, label };
        return this.voicePlaybackChain;
      }
    }

    const { estimatedRenderMs, estimatedPlaybackMs } = estimateReasoningSpeechTiming(normalizedText);
    const job: ReasoningSpeechJob = {
      id: this.nextReasoningSpeechJobId,
      label: `${label}_${this.nextReasoningSpeechJobId}`,
      text: normalizedText,
      createdAt: now,
      estimatedRenderMs,
      estimatedPlaybackMs,
      cancelled: false,
      phase: "queued",
      playbackStartedAt: null,
      abortController: null,
    };
    this.nextReasoningSpeechJobId += 1;

    return this.scheduleReasoningSpeechJob(job);
  }

  private scheduleReasoningSpeechJob(job: ReasoningSpeechJob): Promise<void> {
    const generation = this.voicePlaybackGeneration;
    this.activeReasoningSpeechJob = job;
    this.voicePlaybackChain = this.voicePlaybackChain
      .catch(() => undefined)
      .then(async () => {
        if (generation !== this.voicePlaybackGeneration || job.cancelled) {
          return;
        }

        const channelName = this.getCurrentVoiceChannelName();
        if (!channelName) {
          return;
        }

        let rendered: RenderedVoiceSpeechChunk | null = null;
        try {
          job.phase = "rendering";
          job.abortController = new AbortController();
          rendered = await this.renderVoiceSpeechChunk(
            job.text,
            {
              label: job.label,
              guildName: this.getCurrentVoiceGuildName(),
              channelName,
            },
            job.abortController.signal,
          );
          job.abortController = null;

          if (generation !== this.voicePlaybackGeneration || job.cancelled) {
            return;
          }

          job.phase = "playing";
          job.playbackStartedAt = Date.now();
          await this.playVoiceWav(
            rendered.wavPath,
            {
              label: job.label,
              guildName: this.getCurrentVoiceGuildName(),
              channelName,
              interruptCurrent: true,
            },
            rendered.preview,
          );
        } catch (error) {
          if (!job.cancelled || !isAbortError(error)) {
            this.logger.warn(`Failed to generate or play Discord voice speech (${job.label})`, error);
          }
        } finally {
          job.abortController = null;
          job.phase = "done";
          if (rendered) {
            await this.disposeRenderedVoiceSpeechChunk(rendered);
          }
          if (this.activeReasoningSpeechJob === job) {
            this.activeReasoningSpeechJob = null;
          }
          if (!this.activeReasoningSpeechJob && this.deferredReasoningSpeech) {
            const deferred = this.deferredReasoningSpeech;
            this.deferredReasoningSpeech = null;
            void this.enqueueReasoningVoiceSpeech(deferred.text, deferred.label);
          }
        }
      });

    return this.voicePlaybackChain;
  }

  private cancelReasoningSpeechJob(job: ReasoningSpeechJob, reason: string): void {
    job.cancelled = true;
    job.abortController?.abort();

    if (job.phase === "playing" && this.currentVoiceLabel === job.label) {
      this.stopCurrentVoicePlayback(reason);
    }
  }

  private beginCodexActivity(): () => void {
    this.activeCodexTurns += 1;
    this.ensureWorkingSfxLoop();

    let finished = false;
    return () => {
      if (finished) {
        return;
      }

      finished = true;
      this.activeCodexTurns = Math.max(0, this.activeCodexTurns - 1);
      if (this.activeCodexTurns === 0) {
        this.stopWorkingSfxLoop?.();
      }
    };
  }

  private ensureWorkingSfxLoop(): void {
    if (this.stopWorkingSfxLoop || this.config.discordWorkingSfx.length === 0) {
      return;
    }

    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    const schedule = () => {
      if (stopped) {
        return;
      }

      timer = setTimeout(() => {
        void tick();
      }, CODEX_WORKING_SFX_INTERVAL_MS);
    };

    const stop = () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (this.currentVoicePlayer && this.currentVoiceLabel === "working_sfx") {
        this.currentVoicePlayer.stop(true);
        this.currentVoicePlayer = null;
        this.currentVoiceLabel = null;
      }
      if (this.stopWorkingSfxLoop === stop) {
        this.stopWorkingSfxLoop = null;
      }
    };

    const tick = async () => {
      if (stopped) {
        return;
      }

      if (this.shuttingDown || this.activeCodexTurns === 0) {
        stop();
        return;
      }

      if (
        this.workingSfxSuppressionKeys.size === 0 &&
        this.activeVoiceRenderCount === 0 &&
        !this.currentVoicePlayer &&
        Date.now() - this.lastSpeechPlaybackEndedAt >= VOICE_SFX_AFTER_SPEECH_COOLDOWN_MS
      ) {
        await this.playVoiceVariant(
          pickRandom(this.config.discordWorkingSfx)!,
          {
            label: "working_sfx",
            guildName: this.getCurrentVoiceGuildName(),
            channelName: this.getCurrentVoiceChannelName(),
          },
          { randomizeStart: true, clipDurationSeconds: CODEX_WORKING_SFX_CLIP_DURATION_SECONDS },
        );
      }

      schedule();
    };

    this.stopWorkingSfxLoop = stop;
    schedule();
  }

  private async playVoiceCue(
    text: string,
    context: { label: string; guildName: string | null; channelName: string | null },
    sfx?: string,
  ): Promise<void> {
    if (sfx) {
      await this.playVoiceVariant(sfx, context);
    }

    const parsedText = parseVariantEntry(text);
    if (parsedText && parsedText.kind !== "text") {
      await this.playVoiceSfx(parsedText.value, context, { interruptCurrent: true });
      return;
    }

    await this.playVoiceText(text, context);
  }

  private async playVoiceVariant(
    value: string,
    context: { label: string; guildName: string | null; channelName: string | null },
    options?: { randomizeStart?: boolean; clipDurationSeconds?: number; interruptCurrent?: boolean },
  ): Promise<void> {
    const parsed = parseVariantEntry(value);
    if (!parsed) {
      return;
    }

    if (parsed.kind === "text") {
      void this.mirrorVoiceNotificationText(parsed.value, context.label);
      await this.playVoiceText(parsed.value, context, { interruptCurrent: options?.interruptCurrent ?? true });
      return;
    }

    await this.playVoiceSfx(parsed.value, context, options);
  }

  private async mirrorVoiceNotificationText(text: string, label: string): Promise<void> {
    if (!label.startsWith("voice_")) {
      return;
    }

    const content = text.trim();
    if (!content) {
      return;
    }

    try {
      const channel = await this.getConfiguredTextChannel();
      await channel.send({ content });
    } catch (error) {
      this.logger.warn(`Failed to mirror voice notification text for ${label}`, error);
    }
  }

  private async sendResponseMessage(
    context: UserInputContext,
    options: MessageCreateOptions,
  ): Promise<EditableMessageLike> {
    const payload = this.buildResponseMessageOptions(context, options);
    if (context.message) {
      return (await context.message.reply(payload)) as EditableMessageLike;
    }

    const channel = await this.getConfiguredTextChannel();
    return (await channel.send(payload)) as EditableMessageLike;
  }

  private async updateCodexProgressMirror(context: UserInputContext, text: string): Promise<void> {
    const content = text.trim();
    if (!content) {
      return;
    }

    const state = this.codexProgressMirrors.get(context.requestId) ?? { latestContent: "", message: null };
    if (state.latestContent === content) {
      return;
    }

    state.latestContent = content;

    try {
      if (state.message) {
        await this.editResponseMessage(state.message, { content });
      } else {
        state.message = await this.sendResponseMessage(context, { content });
      }
      this.codexProgressMirrors.set(context.requestId, state);
    } catch (error) {
      this.logger.warn(`Failed to update codex progress mirror for ${context.requestId}`, error);
    }
  }

  private takeCodexProgressMirror(requestId: string): EditableMessageLike | null {
    const state = this.codexProgressMirrors.get(requestId) ?? null;
    this.codexProgressMirrors.delete(requestId);
    return state?.message ?? null;
  }

  private async editResponseMessage(message: EditableMessageLike, options: MessageCreateOptions): Promise<void> {
    await message.edit(options);
  }

  private setWorkingSfxSuppressed(requestId: string, suppressed: boolean): void {
    if (suppressed) {
      this.workingSfxSuppressionKeys.add(requestId);
      if (this.currentVoicePlayer && this.currentVoiceLabel === "working_sfx") {
        this.currentVoicePlayer.stop(true);
        this.currentVoicePlayer = null;
        this.currentVoiceLabel = null;
      }
      return;
    }

    this.workingSfxSuppressionKeys.delete(requestId);
  }

  private buildResponseMessageOptions(context: UserInputContext, options: MessageCreateOptions): MessageCreateOptions {
    if (!context.message) {
      return options;
    }

    return {
      ...options,
      allowedMentions: {
        repliedUser: false,
        ...(options.allowedMentions ?? {}),
      },
    };
  }

  private async playVoiceSfx(
    sfx: string,
    context: { label: string; guildName: string | null; channelName: string | null },
    options?: { randomizeStart?: boolean; clipDurationSeconds?: number; interruptCurrent?: boolean },
  ): Promise<void> {
    const voice = this.voiceModule;
    if (!this.voiceConnection || !voice) {
      return;
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-sfx-"));
    const wavPath = path.join(tempDir, `${context.label}.wav`);
    const generation = this.voicePlaybackGeneration;
    this.activeVoiceRenderCount += 1;

    try {
      this.logger.info("Generating Discord voice SFX", {
        label: context.label,
        guildName: context.guildName,
        channelName: context.channelName,
        sfx,
        randomizeStart: options?.randomizeStart ?? false,
      });
      await generateSfxWav(this.config.ffmpegPath ?? "ffmpeg", sfx, wavPath, options);
      if (generation !== this.voicePlaybackGeneration) {
        return;
      }
      await this.playVoiceWav(
        wavPath,
        {
          ...context,
          interruptCurrent: options?.interruptCurrent ?? false,
        },
        `sfx:${sfx}`,
      );
    } catch (error) {
      this.logger.warn(`Failed to generate or play Discord voice SFX (${context.label})`, error);
    } finally {
      this.activeVoiceRenderCount = Math.max(0, this.activeVoiceRenderCount - 1);
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async playVoiceText(
    text: string,
    context: { label: string; guildName: string | null; channelName: string | null },
    options?: { interruptCurrent?: boolean },
  ): Promise<void> {
    const generation = this.voicePlaybackGeneration;
    let rendered: RenderedVoiceSpeechChunk | null = null;

    try {
      rendered = await this.renderVoiceSpeechChunk(text, context);
      if (generation !== this.voicePlaybackGeneration) {
        return;
      }
      await this.playVoiceWav(
        rendered.wavPath,
        {
          ...context,
          interruptCurrent: options?.interruptCurrent ?? true,
        },
        rendered.preview,
      );
    } catch (error) {
      this.logger.warn(`Failed to generate or play Discord voice speech (${context.label})`, error);
    } finally {
      if (rendered) {
        await this.disposeRenderedVoiceSpeechChunk(rendered);
      }
    }
  }

  private async renderVoiceSpeechChunk(
    text: string,
    context: { label: string; guildName: string | null; channelName: string | null },
    signal?: AbortSignal,
  ): Promise<RenderedVoiceSpeechChunk> {
    const piperPath = this.config.piperPath ?? "piper";
    const piperModelPath = this.config.piperModelPath;
    if (!piperModelPath) {
      this.logger.warn("Skipping voice speech because PIPER_MODEL_PATH is missing");
      throw new Error("PIPER_MODEL_PATH is missing");
    }

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-discord-piper-"));
    const wavPath = path.join(tempDir, `${context.label}.wav`);
    this.activeVoiceRenderCount += 1;

    try {
      this.logger.info("Generating Discord voice speech with Piper", {
        label: context.label,
        guildName: context.guildName,
        channelName: context.channelName,
        modelPath: piperModelPath,
        textPreview: truncateInline(text, 120),
      });

      await runPiper(
        piperPath,
        piperModelPath,
        wavPath,
        text,
        {
          lengthScale: this.config.piperLengthScale,
          noiseScale: this.config.piperNoiseScale,
          noiseW: this.config.piperNoiseW,
          sentenceSilence: this.config.piperSentenceSilence,
        },
        signal,
      );

      return {
        tempDir,
        wavPath,
        preview: truncateInline(text, 120),
      };
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      throw error;
    } finally {
      this.activeVoiceRenderCount = Math.max(0, this.activeVoiceRenderCount - 1);
    }
  }

  private async disposeRenderedVoiceSpeechChunk(rendered: RenderedVoiceSpeechChunk): Promise<void> {
    await rm(rendered.tempDir, { recursive: true, force: true });
  }

  private async playVoiceWav(
    wavPath: string,
    context: {
      label: string;
      guildName: string | null;
      channelName: string | null;
      interruptCurrent: boolean;
    },
    preview: string,
  ): Promise<void> {
    const voice = this.voiceModule;
    if (!this.voiceConnection || !voice) {
      return;
    }

    if (context.interruptCurrent && this.currentVoicePlayer) {
      this.currentVoicePlayer.stop(true);
      this.currentVoicePlayer = null;
    }

    const player = voice.createAudioPlayer({
      behaviors: {
        noSubscriber: voice.NoSubscriberBehavior.Play,
      },
    });
    this.currentVoicePlayer = player;
    this.currentVoiceLabel = context.label;
    this.voiceConnection.subscribe(player);
    player.on("stateChange", (oldState, newState) => {
      this.logger.info("Discord voice player state changed", {
        label: context.label,
        guildName: context.guildName,
        channelName: context.channelName,
        oldStatus: oldState.status,
        newStatus: newState.status,
      });
    });
    player.on("error", (error) => {
      this.logger.error("Discord voice player failed", error);
    });

    try {
      const resource = voice.createAudioResource(createReadStream(wavPath), {
        inputType: voice.StreamType.Arbitrary,
      });

      player.play(resource);
      this.logger.info("Started Discord voice playback", {
        label: context.label,
        guildName: context.guildName,
        channelName: context.channelName,
        textPreview: preview,
      });
      await waitForAudioPlayerToFinish(player, voice);
    } finally {
      if (context.label !== "working_sfx") {
        this.lastSpeechPlaybackEndedAt = Date.now();
      }
      if (this.currentVoicePlayer === player) {
        this.currentVoicePlayer = null;
        this.currentVoiceLabel = null;
      }
    }
  }

  private interruptVoicePlayback(reason: string): void {
    if (this.activeReasoningSpeechJob) {
      this.cancelReasoningSpeechJob(this.activeReasoningSpeechJob, reason);
      this.activeReasoningSpeechJob = null;
    }
    this.deferredReasoningSpeech = null;
    this.voicePlaybackGeneration += 1;
    this.voicePlaybackChain = Promise.resolve();
    this.stopCurrentVoicePlayback(reason, "Interrupting Discord voice playback");
  }

  private stopCurrentVoicePlayback(reason: string, logMessage = "Stopping Discord voice playback"): void {
    if (!this.currentVoicePlayer) {
      return;
    }

    this.logger.info(logMessage, {
      reason,
      label: this.currentVoiceLabel ?? null,
    });
    this.lastVoicePlaybackInterruptedAt = Date.now();
    this.currentVoicePlayer.stop(true);
    this.currentVoicePlayer = null;
    this.currentVoiceLabel = null;
  }

  private wasVoicePlaybackInterruptedRecently(): boolean {
    if (this.lastVoicePlaybackInterruptedAt === 0) {
      return false;
    }

    return Date.now() - this.lastVoicePlaybackInterruptedAt <= VOICE_STOP_COMMAND_WINDOW_MS;
  }

  private getCurrentVoiceGuildName(): string | null {
    if (!this.config.discordVoiceChannelId) {
      return null;
    }

    const channel = this.client.channels.cache.get(this.config.discordVoiceChannelId);
    return channel && "guild" in channel ? channel.guild.name : null;
  }

  private getCurrentVoiceChannelName(): string | null {
    if (!this.config.discordVoiceChannelId) {
      return null;
    }

    const channel = this.client.channels.cache.get(this.config.discordVoiceChannelId);
    return channel?.isVoiceBased() ? channel.name : null;
  }

  private getCodexProgressMessages(group: "start" | "reasoning" | "tool" | "plan" | "working"): string[] {
    switch (group) {
      case "start":
        return this.config.discordCodexStartMessages;
      case "reasoning":
        return this.config.discordCodexReasoningMessages;
      case "tool":
        return this.config.discordCodexToolMessages;
      case "plan":
        return this.config.discordCodexPlanMessages;
      case "working":
      default:
        return this.config.discordCodexWorkingMessages;
    }
  }
}

class DiscordTypingIndicator {
  private timer: NodeJS.Timeout | null = null;
  private active = false;

  constructor(private readonly channel: SendableTextChannel) {}

  async start(): Promise<void> {
    if (this.active) {
      return;
    }

    this.active = true;
    await this.channel.sendTyping();
    this.timer = setInterval(() => {
      void this.channel.sendTyping();
    }, TYPING_KEEPALIVE_MS);
  }

  stop(): void {
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function readProjectInfo(): ProjectInfo {
  try {
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
    };

    return {
      name: packageJson.name?.trim() || "project",
    };
  } catch {
    return { name: "project" };
  }
}

class DiscordMessageStream {
  private summaryContent = "";

  async appendSummary(delta: string): Promise<void> {
    this.summaryContent += delta;
  }

  async appendSummaryBreak(): Promise<void> {
    if (!this.summaryContent || this.summaryContent.endsWith("\n\n")) {
      return;
    }

    this.summaryContent += "\n\n";
  }

  getLiveSummaryContent(): string {
    const normalized = this.summaryContent.trim();
    if (!normalized) {
      return "";
    }

    return chunkMessage(normalized).at(-1) ?? normalized;
  }

  getFinalContent(fullResponse: string): string {
    return fullResponse.trim() || this.summaryContent.trim();
  }
}

function windowUsed(window: AccountRateLimitWindow): number {
  return Math.max(0, Math.min(100, window.usedPercent));
}

function windowAvailable(window: AccountRateLimitWindow): number {
  return 100 - windowUsed(window);
}

function summarizeMessageContent(message: Message): string {
  const content = message.content.trim();
  const attachmentSummary = summarizeAttachmentNames(message);
  if (content) {
    if (attachmentSummary) {
      return truncateInline(`${content} [attachments: ${attachmentSummary}]`, 96);
    }

    return truncateInline(content, 96);
  }

  const firstEmbedText =
    message.embeds
      .map((embed) => [embed.title, embed.description].filter(Boolean).join(". ").trim())
      .find(Boolean) || "";

  if (firstEmbedText) {
    return truncateInline(firstEmbedText, 96);
  }

  if (attachmentSummary) {
    return truncateInline(`wiadomosc z zalacznikami: ${attachmentSummary}`, 96);
  }

  return "wczesniejsza wiadomosc bez tekstu";
}

function truncateInline(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}

function formatCodexProgressMirrorMessage(
  group: "start" | "reasoning" | "tool" | "plan" | "working",
  headline: string | undefined,
  detail: string | undefined,
  detailFormat: CodexProgressDetailFormat,
  fallbackMessage: string | undefined,
  informative: boolean,
): string {
  const normalizedHeadline = headline?.trim() ?? "";
  const normalizedDetail = detail?.trim() ?? "";
  const normalizedFallback = fallbackMessage?.trim() ?? "";

  if (group === "reasoning" || group === "plan") {
    if (!informative || detailFormat !== "plain" || !normalizedDetail) {
      return "";
    }

    return shouldSuppressCodexProgressMirrorMessage(group, normalizedDetail, informative)
      ? ""
      : wrapItalic(normalizedDetail);
  }

  if (group === "start") {
    return normalizedFallback;
  }

  if (group === "tool") {
    if (!informative) {
      return "";
    }

    if (normalizedDetail) {
      return formatProgressDetail(normalizedDetail, detailFormat);
    }

    return normalizedHeadline ? wrapInlineCode(normalizedHeadline) : "";
  }

  const prefix = `_${group}_`;
  const baseMessage = normalizedDetail || normalizedHeadline || normalizedFallback;

  if (!baseMessage) {
    return "";
  }

  if (shouldSuppressCodexProgressMirrorMessage(group, baseMessage, informative)) {
    return "";
  }

  const customLine = normalizedFallback;
  const detailLine = informative
    ? normalizedDetail
      ? `${prefix} ${formatProgressDetail(normalizedDetail, detailFormat)}`
      : normalizedHeadline
        ? `${prefix} (${wrapItalic(normalizedHeadline)})`
        : ""
    : normalizedHeadline && normalizedHeadline !== normalizedFallback
      ? `${prefix} (${wrapItalic(normalizedHeadline)})`
      : "";

  if (customLine && detailLine) {
    return `${customLine}\n${detailLine}`;
  }

  return customLine || detailLine || "";
}

function formatProgressDetail(value: string, detailFormat: CodexProgressDetailFormat): string {
  return detailFormat === "plain" ? value : wrapInlineCode(value);
}

function isAllowedDiscordAttachmentPath(filePath: string): boolean {
  const normalizedPath = filePath.trim();
  if (!normalizedPath) {
    return false;
  }

  const ext = path.extname(normalizedPath).toLowerCase();
  if (DISCORD_ATTACHMENT_EXTENSIONS.has(ext)) {
    return true;
  }

  const basename = path.basename(normalizedPath).toLowerCase();
  return DISCORD_ATTACHMENT_BASENAMES.has(basename);
}

function selectSpokenCodexProgressMessage(
  group: "start" | "reasoning" | "tool" | "plan" | "working",
  headline: string | undefined,
  detail: string | undefined,
  detailFormat: CodexProgressDetailFormat,
  fallbackMessage: string | undefined,
  informative: boolean,
): string {
  const normalizedHeadline = headline?.trim() ?? "";
  const normalizedDetail = detail?.trim() ?? "";
  const normalizedFallback = fallbackMessage?.trim() ?? "";
  const baseMessage = normalizedDetail || normalizedHeadline || normalizedFallback;

  if (group === "start") {
    return normalizedFallback;
  }

  if (!informative || shouldSuppressCodexProgressMirrorMessage(group, baseMessage, informative)) {
    return "";
  }

  if (group === "reasoning" || group === "plan") {
    return detailFormat === "plain" && normalizedDetail ? normalizedDetail : "";
  }

  return normalizedFallback;
}

function shouldSuppressCodexProgressMirrorMessage(
  group: "start" | "reasoning" | "tool" | "plan" | "working",
  message: string,
  informative: boolean,
): boolean {
  const normalized = message.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  if (!informative) {
    return group !== "start";
  }

  return [
    "i am analyzing this.",
    "i am building a plan.",
    "i have an outline now.",
    "still analyzing this.",
    "the tool is working.",
    "composing the response.",
    "composing the final response.",
    "finalizing the response.",
    "wrapping up the response.",
    "response completed.",
  ].includes(normalized);
}

function wrapInlineCode(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  const longestRun = Math.max(...(normalized.match(/`+/g) ?? [""]).map((part) => part.length));
  const fence = "`".repeat(longestRun + 1);
  return `${fence}${normalized}${fence}`;
}

function wrapItalic(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  return `*${normalized.replace(/[\\*_`]/g, "\\$&")}*`;
}

function buildReplyInput(
  referencedMessage: Message,
  replyContent: string,
  referencedAttachments: SavedIncomingAttachment[],
): string {
  const referencedSummary = summarizeMessageContent(referencedMessage);
  const normalizedReply = replyContent.trim() || "(brak tresci)";
  const attachmentContext = buildOptionalAttachmentContext(referencedAttachments, "zalaczniki cytowanej wiadomosci");

  return withOptionalContext(`Kontekst reply: "${referencedSummary}"\nOdpowiedz: ${normalizedReply}`, attachmentContext);
}

function buildVoiceChannelInput(userId: string, transcript: string): string {
  return `Voice channel user ${userId}: ${transcript}`;
}

function buildAttachmentInput(attachments: SavedIncomingAttachment[], label = "zalaczniki"): string {
  const lines = attachments.map(
    (attachment) =>
      `- ${attachment.name} (${attachment.contentType ?? "unknown"}, ${attachment.sizeBytes} bytes) -> ${attachment.path}`,
  );
  return `[${label}]\n${lines.join("\n")}`;
}

type LoadedDiscordVoiceModule = {
  joinVoiceChannel: (options: {
    channelId: string;
    guildId: string;
    adapterCreator: unknown;
    selfDeaf: boolean;
    selfMute: boolean;
  }) => VoiceConnectionLike;
  entersState: (target: unknown, status: unknown, timeoutOrSignal: number) => Promise<unknown>;
  getVoiceConnection?: (guildId: string) => unknown;
  AudioPlayerStatus: { Idle: unknown };
  EndBehaviorType: { AfterSilence: unknown };
  VoiceConnectionStatus: { Ready: unknown };
  NoSubscriberBehavior: { Play: unknown };
  StreamType: { Arbitrary: unknown };
  createAudioPlayer: (options: {
    behaviors: {
      noSubscriber: unknown;
    };
  }) => AudioPlayerLike;
  createAudioResource: (input: unknown, options: { inputType: unknown }) => unknown;
};

type AudioPlayerLike = {
  on: (event: string, listener: (...args: any[]) => void) => void;
  play: (resource: unknown) => void;
  stop: (force?: boolean) => void;
};

type VoiceConnectionLike = {
  on?: (
    event: "stateChange",
    listener: (oldState: VoiceConnectionStateLike, newState: VoiceConnectionStateLike) => void,
  ) => void;
  state?: VoiceConnectionStateLike;
  destroy(): void;
  subscribe(player: AudioPlayerLike): unknown;
  receiver: {
    __codexReceiverAttached?: boolean;
    speaking: {
      on: (event: "start", listener: (userId: string) => void) => void;
    };
    subscribe: (
      userId: string,
      options: {
        end: {
          behavior: unknown;
          duration: number;
        };
      },
    ) => NodeJS.ReadableStream;
  };
};

interface SavedIncomingAttachment {
  name: string;
  contentType: string | null;
  sizeBytes: number;
  path: string;
}

type VoiceConnectionStateLike = {
  status?: string;
  networking?: {
    state?: {
      code?: number;
      endpoint?: string;
      serverId?: string;
    };
  };
};

type PrismMediaModule = {
  opus?: {
    Decoder?: new (options: { rate: number; channels: number; frameSize: number }) => NodeJS.ReadWriteStream;
  };
};

async function loadDiscordVoiceModule(): Promise<LoadedDiscordVoiceModule | null> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier);") as (specifier: string) => Promise<unknown>;
    const voice = (await dynamicImport("@discordjs/voice")) as LoadedDiscordVoiceModule;
    
    return voice;
  } catch {
    return null;
  }
}

async function runPiper(
  piperPath: string,
  modelPath: string,
  outputPath: string,
  text: string,
  options?: {
    lengthScale?: number;
    noiseScale?: number;
    noiseW?: number;
    sentenceSilence?: number;
  },
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args = ["--model", modelPath, "--output_file", outputPath];
    if (options?.lengthScale !== undefined) {
      args.push("--length_scale", String(options.lengthScale));
    }
    if (options?.noiseScale !== undefined) {
      args.push("--noise_scale", String(options.noiseScale));
    }
    if (options?.noiseW !== undefined) {
      args.push("--noise_w", String(options.noiseW));
    }
    if (options?.sentenceSilence !== undefined) {
      args.push("--sentence_silence", String(options.sentenceSilence));
    }

    const child = spawn(piperPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;

    const finish = (handler: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      signal?.removeEventListener("abort", handleAbort);
      handler();
    };

    const handleAbort = (): void => {
      child.kill("SIGTERM");
      const error = new Error("Piper render aborted");
      error.name = "AbortError";
      finish(() => reject(error));
    };

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("close", (code) => {
      if (code === 0) {
        finish(resolve);
        return;
      }

      finish(() => reject(new Error(`Piper exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`)));
    });

    if (signal?.aborted) {
      handleAbort();
      return;
    }

    signal?.addEventListener("abort", handleAbort, { once: true });

    child.stdin.write(text);
    child.stdin.end();
  });
}

async function generateSfxWav(
  ffmpegPath: string,
  sfx: string,
  outputPath: string,
  options?: { randomizeStart?: boolean; clipDurationSeconds?: number },
): Promise<void> {
  const inputArgs = ["-i", sfx];
  const outputArgs = [
    "-ar",
    "48000",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    outputPath,
  ];

  if (options?.randomizeStart) {
    const durationSeconds = await probeMediaDurationSeconds(ffmpegPath, sfx);
    const clipDurationSeconds = Math.max(0.8, options.clipDurationSeconds ?? 1.8);
    const maxOffset = Math.max(0, durationSeconds - clipDurationSeconds);
    const offsetSeconds = maxOffset > 0 ? Math.random() * maxOffset : 0;
    inputArgs.unshift("-stream_loop", "-1");
    outputArgs.unshift("-ss", offsetSeconds.toFixed(3), "-t", clipDurationSeconds.toFixed(3));
  }

  await execFile(ffmpegPath, ["-y", ...inputArgs, ...outputArgs]);
}

async function probeMediaDurationSeconds(ffmpegPath: string, inputPath: string): Promise<number> {
  const ffprobePath = ffmpegPath.replace(/ffmpeg(?:\.exe)?$/i, "ffprobe");

  try {
    const { stdout } = await execFile(ffprobePath, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);
    const duration = Number.parseFloat(stdout.trim());
    if (Number.isFinite(duration) && duration > 0) {
      return duration;
    }
  } catch {
    // fall through to ffmpeg stderr parsing
  }

  try {
    await execFile(ffmpegPath, ["-i", inputPath]);
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string") {
      const match = error.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (match) {
        const [, hoursText = "0", minutesText = "0", secondsText = "0"] = match;
        const hours = Number.parseInt(hoursText, 10);
        const minutes = Number.parseInt(minutesText, 10);
        const seconds = Number.parseFloat(secondsText);
        return hours * 3600 + minutes * 60 + seconds;
      }
    }
  }

  return 0;
}

async function loadPrismMediaModule(): Promise<PrismMediaModule | null> {
  try {
    return eval("require")("prism-media") as PrismMediaModule;
  } catch {
    return null;
  }
}

async function computePcmSignalMetrics(filePath: string): Promise<{
  rms: number;
  activeRatio: number;
}> {
  const buffer = await readFile(filePath);
  if (buffer.length < 2) {
    return { rms: 0, activeRatio: 0 };
  }

  let sumSquares = 0;
  let samples = 0;
  let activeSamples = 0;
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset) / 32768;
    const amplitude = Math.abs(sample);
    sumSquares += sample * sample;
    samples += 1;
    if (amplitude >= 0.02) {
      activeSamples += 1;
    }
  }

  if (samples === 0) {
    return { rms: 0, activeRatio: 0 };
  }

  return {
    rms: Math.sqrt(sumSquares / samples),
    activeRatio: activeSamples / samples,
  };
}

async function waitForAudioPlayerToFinish(player: AudioPlayerLike, voice: LoadedDiscordVoiceModule): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    player.on("stateChange", (_oldState, newState) => {
      if (newState?.status === voice.AudioPlayerStatus.Idle) {
        finish();
      }
    });
    player.on("error", () => {
      finish();
    });
    setTimeout(finish, 120_000);
  });
}

function normalizeSpeechText(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countSpeechWords(value: string): number {
  const normalized = normalizeSpeechText(value);
  if (!normalized) {
    return 0;
  }

  return normalized.split(/\s+/).filter(Boolean).length;
}

function estimateReasoningSpeechTiming(value: string): { estimatedRenderMs: number; estimatedPlaybackMs: number } {
  const wordCount = Math.max(1, countSpeechWords(value));
  return {
    estimatedRenderMs: Math.max(PIPER_ESTIMATED_RENDER_MIN_MS, wordCount * PIPER_ESTIMATED_RENDER_MS_PER_WORD),
    estimatedPlaybackMs: Math.max(PIPER_ESTIMATED_AUDIO_MIN_MS, wordCount * PIPER_ESTIMATED_AUDIO_MS_PER_WORD),
  };
}

function shouldSupersedeReasoningSpeech(job: ReasoningSpeechJob, now: number): boolean {
  const readableAtMs =
    (job.playbackStartedAt ?? job.createdAt + job.estimatedRenderMs) +
    job.estimatedPlaybackMs * REASONING_SUPERSEDE_READ_FRACTION;
  return now < readableAtMs;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function looksLikeAudioVariant(value: string): boolean {
  const parsed = parseVariantEntry(value);
  return parsed ? parsed.kind !== "text" : false;
}

function splitSpeechText(value: string, sentencesPerChunk: number): string[] {
  const normalized = value.trim();
  if (!normalized) {
    return [];
  }

  const protectedText = normalized
    .replace(/\b[a-z]:\\/gi, (match) => match.replace(/\./g, "DOT_PLACEHOLDER"))
    .replace(/(^|[\s(])\.[A-Za-z0-9_-]+/g, (match) => match.replace(/\./g, "DOT_PLACEHOLDER"))
    .replace(/\b[\w/-]+\.[A-Za-z0-9_-]+\b/g, (match) => match.replace(/\./g, "DOT_PLACEHOLDER"));

  const sentences =
    protectedText
      .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
      ?.map((part) => part.trim())
      .map((part) => part.replace(/DOT_PLACEHOLDER/g, "."))
      .filter(Boolean) ?? [normalized];

  const chunks: string[] = [];
  for (let index = 0; index < sentences.length; index += sentencesPerChunk) {
    const chunk = sentences.slice(index, index + sentencesPerChunk).join(" ").trim();
    if (chunk) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

function compareDiscordIds(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  if (leftValue === rightValue) {
    return 0;
  }

  return leftValue < rightValue ? -1 : 1;
}

function sanitizeAttachmentFilename(value: string): string {
  const trimmed = value.trim() || "attachment";
  return trimmed.replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "_");
}

function buildIncomingAttachmentFilename(attachment: Attachment): string {
  const sanitizedName = sanitizeAttachmentFilename(attachment.name || "attachment");
  return `${attachment.id}_${sanitizedName}`;
}

async function resolveIncomingAttachmentTargetPath(incomingDir: string, attachment: Attachment): Promise<string> {
  const preferredPath = path.join(incomingDir, buildIncomingAttachmentFilename(attachment));
  if (await isRegularFile(preferredPath)) {
    return preferredPath;
  }

  const legacyPath = path.join(incomingDir, sanitizeAttachmentFilename(attachment.name || attachment.id));
  if (await isRegularFile(legacyPath)) {
    return legacyPath;
  }

  return preferredPath;
}

async function readSavedIncomingAttachment(filePath: string): Promise<{ sizeBytes: number } | null> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return null;
    }

    return { sizeBytes: fileStat.size };
  } catch {
    return null;
  }
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

function summarizeAttachmentNames(message: Message): string | null {
  const names = [...message.attachments.values()]
    .map((attachment) => attachment.name?.trim() || attachment.id)
    .filter(Boolean);

  if (names.length === 0) {
    return null;
  }

  const visibleNames = names.slice(0, 3).join(", ");
  const remaining = names.length - 3;
  return remaining > 0 ? `${visibleNames} +${remaining} wiecej` : visibleNames;
}

function buildOptionalAttachmentContext(attachments: SavedIncomingAttachment[], label: string): string {
  if (attachments.length === 0) {
    return "";
  }

  return buildAttachmentInput(attachments, label);
}

function withOptionalContext(input: string, context: string): string {
  if (!context) {
    return input;
  }

  return `${input}\n\n${context}`;
}

function classifyRejectedTranscript(transcript: string): string | null {
  const normalized = transcript.trim();
  if (!normalized) {
    return "empty";
  }

  const commandText = normalizeVoiceCommandText(transcript);
  const lowered = normalized.toLowerCase();
  if (lowered === "[blank_audio]") {
    return "blank_audio";
  }

  if (/\(speaking in foreign language\)/i.test(normalized)) {
    return "foreign_language_marker";
  }

  if (/^\[(t[łl]umaczenie|translation) /i.test(normalized)) {
    return "translation_marker";
  }

  if (/^\[[^\]]+\]$/.test(normalized)) {
    return "bracketed_marker";
  }

  if (!isVoiceStopCommand(commandText)) {
    const words = commandText ? commandText.split(" ").filter(Boolean) : [];
    const letters = [...commandText].filter((character) => /\p{L}/u.test(character)).length;
    const alphaRatio = normalized.length > 0 ? letters / normalized.length : 0;
    const averageWordLength =
      words.length > 0 ? words.reduce((sum, word) => sum + word.length, 0) / words.length : 0;
    const uniqueWords = new Set(words);
    const uniqueRatio = words.length > 0 ? uniqueWords.size / words.length : 0;
    const repeatedPrefix = detectRepeatedPrefix(words);

    if (letters < 6) {
      return "too_short";
    }

    if (words.length <= 1 && letters < 10) {
      return "single_word_too_short";
    }

    if (words.length <= 3 && averageWordLength < 3) {
      return "fragmented_short_phrase";
    }

    if (alphaRatio < 0.55) {
      return "low_alpha_ratio";
    }

    if (repeatedPrefix) {
      return "repeated_phrase";
    }

    if (words.length >= 5 && uniqueRatio < 0.45) {
      return "low_word_diversity";
    }
  }

  return null;
}

function detectRepeatedPrefix(words: string[]): boolean {
  if (words.length < 4) {
    return false;
  }

  for (let size = 1; size <= 3; size += 1) {
    if (words.length < size * 3) {
      continue;
    }

    const prefix = words.slice(0, size).join(" ");
    let repetitions = 1;

    for (let offset = size; offset + size <= words.length; offset += size) {
      const candidate = words.slice(offset, offset + size).join(" ");
      if (candidate !== prefix) {
        break;
      }
      repetitions += 1;
    }

    if (repetitions >= 3) {
      return true;
    }
  }

  return false;
}

function isVoiceStopCommand(transcript: string): boolean {
  const normalized = normalizeVoiceCommandText(transcript);

  if (!normalized) {
    return false;
  }

  if (
    [
      "stop",
      "stój",
      "stoj",
      "wystarczy",
      "przestań",
      "przestan",
      "koniec",
      "cisza",
    ].includes(normalized)
  ) {
    return true;
  }

  return [
    "stop",
    "stój",
    "stoj",
  ].some((command) => normalized.startsWith(`${command} `));
}

function isRestartCommand(transcript: string): boolean {
  const normalized = normalizeVoiceCommandText(transcript);

  if (!normalized) {
    return false;
  }

  if (
    [
      "restart",
      "restartuj",
      "uruchom ponownie",
      "zrestartuj się",
      "zrestartuj sie",
    ].includes(normalized)
  ) {
    return true;
  }

  return [
    "restart",
    "restartuj",
    "uruchom ponownie",
  ].some((command) => normalized.startsWith(`${command} `));
}

function normalizeVoiceCommandText(transcript: string): string {
  return transcript
    .toLowerCase()
    .replace(/[.!?,;:"'`~()[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickRandom(values: string[]): string | undefined {
  if (values.length === 0) {
    return undefined;
  }

  const index = Math.floor(Math.random() * values.length);
  return values[index];
}

function pickRandomTextVariant(values: string[]): string | undefined {
  return pickRandom(values.filter((value) => !looksLikeAudioVariant(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
