import type { AppConfig } from "../config/env.js";
import type {
  AccountRateLimitsUpdatedNotification,
  AccountRateLimitSnapshot,
  AgentMessageDeltaNotification,
  CodexTurnResult,
  CodexTurnStreamHandlers,
  ErrorNotification,
  GetAccountRateLimitsResponse,
  InitializeResponse,
  ReasoningSummaryPartAddedNotification,
  ReasoningSummaryTextDeltaNotification,
  ThreadTokenUsage,
  ThreadTokenUsageUpdatedNotification,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnCompletedNotification,
  TurnStartResponse,
  UserTextInput,
} from "../types/codex.js";
import type { JsonRpcNotificationEvent, JsonRpcRequestEvent } from "./jsonRpcClient.js";
import { CodexAppServer } from "./appServer.js";
import { CodexThreadStore } from "./threadStore.js";
import { Logger } from "../utils/logger.js";

interface PendingTurn {
  turnId: string;
  chunks: string[];
  tokenUsage: ThreadTokenUsage | null;
  accountRateLimits: AccountRateLimitSnapshot | null;
  stream?: CodexTurnStreamHandlers;
  resolve: (value: CodexTurnResult) => void;
  reject: (reason: Error) => void;
}

export class CodexSession {
  private readonly appServer: CodexAppServer;
  private readonly threadStore: CodexThreadStore;
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private accountRateLimits: AccountRateLimitSnapshot | null = null;
  private threadId: string | null = null;
  private initialized = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.appServer = new CodexAppServer(logger);
    this.threadStore = new CodexThreadStore(config.codexThreadMapPath);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const client = await this.appServer.start();
    client.on("notification", (event: JsonRpcNotificationEvent) => {
      this.handleNotification(event);
    });
    client.on("request", (event: JsonRpcRequestEvent) => {
      void this.handleServerRequest(event);
    });

    await client.request<InitializeResponse>("initialize", {
      clientInfo: {
        name: "codex-discord-bridge",
        version: "0.1.0",
      },
      capabilities: null,
    });

    this.threadId = await this.restoreOrCreateThread();
    this.accountRateLimits = await this.readAccountRateLimits();
    this.initialized = true;
    this.logger.info(`Codex thread ready: ${this.threadId}`);
  }

  async sendUserMessage(message: string, stream?: CodexTurnStreamHandlers): Promise<CodexTurnResult> {
    if (!this.threadId) {
      throw new Error("Codex session is not initialized");
    }

    if (typeof message !== "string" || !message.trim()) {
      throw new Error("Refusing to start a Codex turn with empty user input");
    }

    const client = await this.appServer.start();
    const turnResponse = await client.request<TurnStartResponse>("turn/start", {
      threadId: this.threadId,
      input: [
        {
          type: "text",
          text: message,
          text_elements: [],
        } satisfies UserTextInput,
      ],
    });

    return new Promise<CodexTurnResult>((resolve, reject) => {
      this.pendingTurns.set(turnResponse.turn.id, {
        turnId: turnResponse.turn.id,
        chunks: [],
        tokenUsage: null,
        accountRateLimits: this.accountRateLimits,
        stream,
        resolve,
        reject,
      });
    });
  }

  async shutdown(): Promise<void> {
    await this.persistThreadId();
    for (const pending of this.pendingTurns.values()) {
      pending.reject(new Error("Codex session shut down"));
    }
    this.pendingTurns.clear();
    await this.appServer.stop();
  }

  private async restoreOrCreateThread(): Promise<string> {
    const storedThread = await this.threadStore.get(this.config.discordChannelId);
    if (storedThread?.codexThreadId) {
      try {
        const resumedThread = await this.resumeThread(storedThread.codexThreadId);
        await this.threadStore.set(this.config.discordChannelId, resumedThread);
        this.logger.info(`Resumed Codex thread: ${resumedThread}`);
        return resumedThread;
      } catch (error) {
        this.logger.warn(`Failed to resume Codex thread ${storedThread.codexThreadId}, starting a new one`, error);
      }
    }

    const newThreadId = await this.startThread();
    await this.threadStore.set(this.config.discordChannelId, newThreadId);
    return newThreadId;
  }

  private async startThread(): Promise<string> {
    const client = await this.appServer.start();
    const threadResponse = await client.request<ThreadStartResponse>("thread/start", {
      cwd: this.config.codexCwd,
      model: this.config.codexModel ?? null,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      serviceName: "discord-bridge",
    });

    return threadResponse.thread.id;
  }

  private async resumeThread(threadId: string): Promise<string> {
    const client = await this.appServer.start();
    const threadResponse = await client.request<ThreadResumeResponse>("thread/resume", {
      threadId,
      cwd: this.config.codexCwd,
      model: this.config.codexModel ?? null,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      persistExtendedHistory: false,
    });

    return threadResponse.thread.id;
  }

  private async persistThreadId(): Promise<void> {
    if (!this.threadId) {
      return;
    }

    await this.threadStore.set(this.config.discordChannelId, this.threadId);
  }

  private handleNotification(event: JsonRpcNotificationEvent): void {
    switch (event.method) {
      case "item/agentMessage/delta":
        this.handleAgentDelta(event.params as AgentMessageDeltaNotification);
        return;
      case "item/reasoning/summaryTextDelta":
        this.handleReasoningSummaryDelta(event.params as ReasoningSummaryTextDeltaNotification);
        return;
      case "item/reasoning/summaryPartAdded":
        this.handleReasoningSummaryPartAdded(event.params as ReasoningSummaryPartAddedNotification);
        return;
      case "thread/tokenUsage/updated":
        this.handleTokenUsageUpdated(event.params as ThreadTokenUsageUpdatedNotification);
        return;
      case "account/rateLimits/updated":
        this.handleAccountRateLimitsUpdated(event.params as AccountRateLimitsUpdatedNotification);
        return;
      case "turn/completed":
        this.handleTurnCompleted(event.params as TurnCompletedNotification);
        return;
      case "error":
        this.handleTurnError(event.params as ErrorNotification);
        return;
      default:
        this.logger.debug(`Ignoring notification ${event.method}`);
    }
  }

  private handleAgentDelta(notification: AgentMessageDeltaNotification): void {
    const pending = this.pendingTurns.get(notification.turnId);
    if (!pending) {
      return;
    }

    pending.chunks.push(notification.delta);
  }

  private handleReasoningSummaryDelta(notification: ReasoningSummaryTextDeltaNotification): void {
    const pending = this.pendingTurns.get(notification.turnId);
    if (!pending?.stream?.onSummaryDelta) {
      return;
    }

    void Promise.resolve(pending.stream.onSummaryDelta(notification.delta)).catch((error: unknown) => {
      this.logger.warn(`Failed to process summary delta for turn ${notification.turnId}`, error);
    });
  }

  private handleReasoningSummaryPartAdded(notification: ReasoningSummaryPartAddedNotification): void {
    const pending = this.pendingTurns.get(notification.turnId);
    if (!pending?.stream?.onSummaryPartAdded) {
      return;
    }

    void Promise.resolve(pending.stream.onSummaryPartAdded(notification.summaryIndex)).catch((error: unknown) => {
      this.logger.warn(`Failed to process summary section for turn ${notification.turnId}`, error);
    });
  }

  private handleTokenUsageUpdated(notification: ThreadTokenUsageUpdatedNotification): void {
    const pending = this.pendingTurns.get(notification.turnId);
    if (!pending) {
      return;
    }

    pending.tokenUsage = notification.tokenUsage;
  }

  private handleAccountRateLimitsUpdated(notification: AccountRateLimitsUpdatedNotification): void {
    this.accountRateLimits = notification.rateLimits;

    for (const pending of this.pendingTurns.values()) {
      pending.accountRateLimits = notification.rateLimits;
    }
  }

  private handleTurnCompleted(notification: TurnCompletedNotification): void {
    const pending = this.pendingTurns.get(notification.turn.id);
    if (!pending) {
      return;
    }

    this.pendingTurns.delete(notification.turn.id);

    if (notification.turn.status === "failed") {
      pending.reject(new Error(notification.turn.error?.message || "Codex turn failed"));
      return;
    }

    const response = pending.chunks.join("").trim();
    pending.resolve({
      response: response || "(empty response)",
      tokenUsage: pending.tokenUsage,
      accountRateLimits: pending.accountRateLimits,
    });
  }

  private async readAccountRateLimits(): Promise<AccountRateLimitSnapshot | null> {
    const client = await this.appServer.start();

    try {
      const response = await client.request<GetAccountRateLimitsResponse>("account/rateLimits/read");
      return response.rateLimits;
    } catch (error) {
      this.logger.warn("Failed to read account rate limits", error);
      return null;
    }
  }

  private handleTurnError(notification: ErrorNotification): void {
    const pending = this.pendingTurns.get(notification.turnId);
    if (!pending) {
      return;
    }

    if (notification.willRetry) {
      this.logger.warn(`Turn ${notification.turnId} reported an error but will retry`);
      return;
    }

    this.pendingTurns.delete(notification.turnId);
    pending.reject(new Error(notification.error.message || "Codex turn failed"));
  }

  private async handleServerRequest(event: JsonRpcRequestEvent): Promise<void> {
    const client = await this.appServer.start();

    switch (event.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        await client.respond(event.id, { decision: "decline" });
        return;
      case "item/permissions/requestApproval":
        await client.respond(event.id, {
          permissions: {},
          scope: "turn",
        });
        return;
      case "execCommandApproval":
      case "applyPatchApproval":
        await client.respond(event.id, { decision: "denied" });
        return;
      case "item/tool/requestUserInput":
        await client.respond(event.id, { answers: {} });
        return;
      case "mcpServer/elicitation/request":
        await client.respond(event.id, {
          action: "cancel",
          content: null,
          _meta: null,
        });
        return;
      case "item/tool/call":
        await client.respond(event.id, {
          success: false,
          contentItems: [],
        });
        return;
      case "account/chatgptAuthTokens/refresh":
        await client.respondError(event.id, -32601, "External auth token refresh is not supported by this bridge");
        return;
      default:
        await client.respondError(event.id, -32601, `Unsupported server request: ${event.method}`);
    }
  }
}
