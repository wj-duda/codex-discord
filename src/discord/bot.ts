import { readFileSync } from "node:fs";
import path from "node:path";

import {
  Collection,
  EmbedBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Attachment,
  type Message,
  type MessageCreateOptions,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type TextBasedChannel,
  type User,
} from "discord.js";

import type { AppConfig } from "../config/env.js";
import type {
  AccountRateLimitSnapshot,
  AccountRateLimitWindow,
  CodexTurnResult,
  CodexTurnStreamHandlers,
  ThreadTokenUsage,
} from "../types/codex.js";
import { LocalWhisperTranscriber } from "../stt/localWhisper.js";
import { chunkMessage } from "../utils/chunkMessage.js";
import { Logger } from "../utils/logger.js";

interface ProjectInfo {
  name: string;
}

const PROJECT_INFO = readProjectInfo();
const TYPING_KEEPALIVE_MS = 8_000;

export interface DiscordBotHandlers {
  onUserMessage(input: string, message: Message, stream: CodexTurnStreamHandlers): Promise<CodexTurnResult>;
}

type SendableTextChannel = {
  sendTyping: () => Promise<unknown>;
  send: (options: string | MessageCreateOptions) => Promise<unknown>;
};

export class DiscordBridgeBot {
  private readonly client: Client;
  private readonly transcriber: LocalWhisperTranscriber;
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
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });
    this.transcriber = new LocalWhisperTranscriber(config, logger);
  }

  async start(): Promise<void> {
    this.client.once(Events.ClientReady, async () => {
      try {
        this.logger.info(`Discord bot ready as ${this.client.user?.tag ?? "unknown"}`);
        await this.assertChannelAccessAndAnnounce();
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

    await this.client.login(this.config.discordBotToken);
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    await this.client.destroy();
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  async announce(content: string): Promise<void> {
    const channel = await this.getConfiguredTextChannel();
    await channel.send({
      content,
      tts: true,
    });
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

    if (!message.content.trim() && !this.hasVoiceMessage(message)) {
      return;
    }

    this.logger.info(`Received Discord message from ${message.author.tag}`);
    const input = await this.resolveMessageInput(message);
    this.logger.info(`Resolved Discord input for ${message.id}`, {
      input,
      source: this.hasVoiceMessage(message) ? "voice_or_mixed" : "text",
    });
    await this.processInput(message, input);
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

    const input = this.mapReactionToInput(reaction, message);
    if (!input) {
      return;
    }

    this.logger.info(`Received Discord reaction from ${user.tag}`, {
      messageId: message.id,
      emoji: reaction.emoji.name,
      input,
    });

    await this.processInput(message, input);
  }

  private async processInput(message: Message, input: string): Promise<void> {
    const stream = new DiscordMessageStream();
    const typingIndicator = new DiscordTypingIndicator(message.channel as SendableTextChannel);

    try {
      await typingIndicator.start();
      const result = await this.handlers.onUserMessage(input, message, {
        onSummaryDelta: async (delta) => {
          typingIndicator.stop();
          await stream.appendSummary(delta);
        },
        onSummaryPartAdded: async () => {
          typingIndicator.stop();
          await stream.appendSummaryBreak();
        },
      });
      typingIndicator.stop();
      await this.sendResponse(message, stream, result);
    } catch (error) {
      typingIndicator.stop();
      if (this.isShutdownError(error)) {
        this.logger.info("Skipping Discord reply because the bridge is shutting down");
        return;
      }

      this.logger.error("Failed to process Discord message", error);
      try {
        await this.sendFailureResponse(message, this.formatBridgeError(error));
      } catch (replyError) {
        this.logger.error("Failed to send Discord failure response", replyError);
      }
    }
  }

  private async assertChannelAccessAndAnnounce(): Promise<void> {
    const textChannel = await this.getConfiguredTextChannel();
    await textChannel.sendTyping();
    if (this.config.discordStartupMessage) {
      await this.announce(this.config.discordStartupMessage);
    }
  }

  private async sendResponse(message: Message, stream: DiscordMessageStream, result: CodexTurnResult): Promise<void> {
    const usageEmbed = this.buildTokenUsageEmbed(result.tokenUsage, result.accountRateLimits);
    const segments = chunkMessage(stream.getFinalContent(result.response || "(empty response)"));

    for (const [index, content] of segments.entries()) {
      const isLast = index === segments.length - 1;
      await message.reply({
        content,
        embeds: isLast && usageEmbed ? [usageEmbed] : [],
        tts: true,
        allowedMentions: {
          repliedUser: false,
        },
      });
    }
  }

  private async sendFailureResponse(message: Message, content: string): Promise<void> {
    await message.reply({
      content,
      tts: true,
      allowedMentions: {
        repliedUser: false,
      },
    });
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
      sevenDay ? `7d ${this.formatPercent(windowAvailable(sevenDay))}` : "",
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

    const referencedMessage = await this.resolveReferencedMessage(message);
    if (!referencedMessage) {
      return baseInput;
    }

    return buildReplyInput(referencedMessage, baseInput);
  }

  private async sendTranscriptReceipt(message: Message, transcript: string): Promise<void> {
    await message.reply({
      content: `Otrzymano: ${transcript}`,
      tts: true,
      allowedMentions: {
        repliedUser: false,
      },
    });
  }

  private hasVoiceMessage(message: Message): boolean {
    return message.flags.has("IsVoiceMessage");
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

  private mapReactionToInput(
    reaction: MessageReaction | PartialMessageReaction,
    message: Message,
  ): string | null {
    const emoji = reaction.emoji.name;
    if (!emoji) {
      return null;
    }

    const messageSummary = summarizeMessageContent(message);

    switch (emoji) {
      case "👍":
        return `Reaguję 👍 na wiadomość: "${messageSummary}". Ok.`;
      case "👎":
        return `Reaguję 👎 na wiadomość: "${messageSummary}". Nie, to mi nie pasuje.`;
      case "❤️":
      case "❤":
        return `Reaguję ❤️ na wiadomość: "${messageSummary}". To mi się podoba.`;
      case "🔥":
        return `Reaguję 🔥 na wiadomość: "${messageSummary}". To jest super, idź w tę stronę.`;
      case "🙏":
        return `Reaguję 🙏 na wiadomość: "${messageSummary}". Dzięki.`;
      case "✅":
        return `Reaguję ✅ na wiadomość: "${messageSummary}". Akceptuję to.`;
      case "❌":
        return `Reaguję ❌ na wiadomość: "${messageSummary}". Odrzucam to.`;
      case "😂":
      case "😄":
      case "😆":
      case "😁":
      case "😀":
      case "🤣":
        return `Reaguję ${emoji} na wiadomość: "${messageSummary}". To mnie rozbawiło.`;
      default:
        return `Zareagowałem emoji ${emoji} na wiadomość: "${messageSummary}". Potraktuj to jak moją krótką odpowiedź odnoszącą się do niej.`;
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

  getFinalContent(fullResponse: string): string {
    return this.summaryContent.trim() || fullResponse;
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
  if (content) {
    return truncateInline(content, 96);
  }

  const firstEmbedText =
    message.embeds
      .map((embed) => [embed.title, embed.description].filter(Boolean).join(". ").trim())
      .find(Boolean) || "";

  if (firstEmbedText) {
    return truncateInline(firstEmbedText, 96);
  }

  if (message.attachments.size > 0) {
    return "wiadomosc z zalacznikami";
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

function buildReplyInput(referencedMessage: Message, replyContent: string): string {
  const referencedSummary = summarizeMessageContent(referencedMessage);
  const normalizedReply = replyContent.trim() || "(brak tresci)";

  return `Kontekst reply: "${referencedSummary}"\nOdpowiedz: ${normalizedReply}`;
}
