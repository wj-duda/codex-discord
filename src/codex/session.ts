import type { AppConfig } from "../config/env.js";
import type {
  AccountRateLimitsUpdatedNotification,
  AccountRateLimitSnapshot,
  AgentMessageDeltaNotification,
  CodexTurnResult,
  CodexTurnStreamHandlers,
  CommandExecutionOutputDeltaNotification,
  ContextCompactedNotification,
  ErrorNotification,
  GetAccountRateLimitsResponse,
  HookCompletedNotification,
  HookStartedNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  InitializeResponse,
  McpToolCallProgressNotification,
  ModelReroutedNotification,
  PlanDeltaNotification,
  RawResponseItemCompletedNotification,
  ReasoningTextDeltaNotification,
  ReasoningSummaryPartAddedNotification,
  ReasoningSummaryTextDeltaNotification,
  TerminalInteractionNotification,
  ThreadTokenUsage,
  ThreadTokenUsageUpdatedNotification,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnCompletedNotification,
  TurnDiffUpdatedNotification,
  TurnPlanUpdatedNotification,
  TurnStartResponse,
  TurnStartedNotification,
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
        version: "0.1.2",
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
    if (shouldLogCodexNotification(event.method)) {
      this.logger.info(`Codex notification ${event.method}`, event.params);
    }

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
      case "turn/started":
        this.handleTurnStarted(event.params as TurnStartedNotification);
        return;
      case "item/started":
        this.handleItemStarted(event.params as ItemStartedNotification);
        return;
      case "item/completed":
        this.handleItemCompleted(event.params as ItemCompletedNotification);
        return;
      case "turn/plan/updated":
        this.handleTurnPlanUpdated(event.params as TurnPlanUpdatedNotification);
        return;
      case "item/plan/delta":
        this.handlePlanDelta(event.params as PlanDeltaNotification);
        return;
      case "item/mcpToolCall/progress":
        this.handleMcpToolCallProgress(event.params as McpToolCallProgressNotification);
        return;
      case "item/reasoning/textDelta":
        this.handleReasoningTextDelta(event.params as ReasoningTextDeltaNotification);
        return;
      case "hook/started":
        this.handleHookStarted(event.params as HookStartedNotification);
        return;
      case "hook/completed":
        this.handleHookCompleted(event.params as HookCompletedNotification);
        return;
      case "turn/diff/updated":
        this.handleTurnDiffUpdated(event.params as TurnDiffUpdatedNotification);
        return;
      case "item/commandExecution/outputDelta":
        this.handleCommandExecutionOutputDelta(event.params as CommandExecutionOutputDeltaNotification);
        return;
      case "item/commandExecution/terminalInteraction":
        this.handleTerminalInteraction(event.params as TerminalInteractionNotification);
        return;
      case "rawResponseItem/completed":
        this.handleRawResponseItemCompleted(event.params as RawResponseItemCompletedNotification);
        return;
      case "model/rerouted":
        this.handleModelRerouted(event.params as ModelReroutedNotification);
        return;
      case "thread/compacted":
        this.handleContextCompacted(event.params as ContextCompactedNotification);
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

  private handleTurnStarted(notification: TurnStartedNotification): void {
    this.emitProgressEvent(notification.turn.id, "start", "Zaczynam.", false);
  }

  private handleItemStarted(notification: ItemStartedNotification): void {
    switch (notification.item.type) {
      case "plan":
        this.emitProgressEvent(notification.turnId, "plan", "Układam plan.", false);
        return;
      case "reasoning":
        this.emitProgressEvent(notification.turnId, "reasoning", "Analizuję to.", false);
        return;
      case "commandExecution":
        this.emitProgressEvent(
          notification.turnId,
          "tool",
          sentenceFromCommand(notification.item.command, "Uruchamiam polecenie."),
          Boolean(notification.item.command),
        );
        return;
      case "fileChange":
        this.emitProgressEvent(
          notification.turnId,
          "tool",
          sentenceFromFileChanges(notification.item.changes, "Przygotowuję zmiany w plikach."),
          Boolean(notification.item.changes?.[0]?.path),
        );
        return;
      case "mcpToolCall":
        this.emitProgressEvent(notification.turnId, "tool", "Odpalam narzędzie.", false);
        return;
      case "dynamicToolCall":
        this.emitProgressEvent(notification.turnId, "tool", "Uruchamiam narzędzie.", false);
        return;
      case "collabAgentToolCall":
        this.emitProgressEvent(notification.turnId, "tool", "Odpalam dodatkowe narzędzie.", false);
        return;
      case "webSearch":
        this.emitProgressEvent(notification.turnId, "tool", "Sprawdzam to w sieci.", false);
        return;
      case "imageView":
        this.emitProgressEvent(notification.turnId, "tool", "Patrzę na obraz.", false);
        return;
      case "imageGeneration":
        this.emitProgressEvent(notification.turnId, "tool", "Przygotowuję obraz.", false);
        return;
      case "agentMessage":
        this.emitProgressEvent(
          notification.turnId,
          notification.item.phase === "final_answer" ? "plan" : "reasoning",
          sentenceFromAgentPhase(notification.item.phase, "Składam odpowiedź."),
          Boolean(notification.item.phase),
        );
        return;
      default:
        return;
    }
  }

  private handleItemCompleted(notification: ItemCompletedNotification): void {
    switch (notification.item.type) {
      case "plan":
        this.emitProgressEvent(notification.turnId, "plan", "Plan jest gotowy.", false);
        return;
      case "reasoning":
        this.emitProgressEvent(notification.turnId, "reasoning", "Mam już zarys.", false);
        return;
      case "commandExecution":
        this.emitProgressEvent(
          notification.turnId,
          "tool",
          sentenceFromCommandCompleted(notification.item.command, notification.item.exitCode, "Polecenie skończone."),
          Boolean(notification.item.command),
        );
        return;
      case "fileChange":
        this.emitProgressEvent(
          notification.turnId,
          "tool",
          sentenceFromFileChanges(notification.item.changes, "Zmiany w plikach gotowe."),
          Boolean(notification.item.changes?.[0]?.path),
        );
        return;
      case "mcpToolCall":
        this.emitProgressEvent(notification.turnId, "tool", "Narzędzie skończyło pracę.", false);
        return;
      case "dynamicToolCall":
        this.emitProgressEvent(notification.turnId, "tool", "Narzędzie już wróciło.", false);
        return;
      case "collabAgentToolCall":
        this.emitProgressEvent(notification.turnId, "tool", "Dodatkowe narzędzie wróciło.", false);
        return;
      case "webSearch":
        this.emitProgressEvent(notification.turnId, "tool", "Mam wyniki z sieci.", false);
        return;
      case "imageView":
        this.emitProgressEvent(notification.turnId, "tool", "Obraz sprawdzony.", false);
        return;
      case "imageGeneration":
        this.emitProgressEvent(notification.turnId, "tool", "Obraz jest gotowy.", false);
        return;
      case "agentMessage":
        this.emitProgressEvent(
          notification.turnId,
          notification.item.phase === "final_answer" ? "plan" : "reasoning",
          sentenceFromAgentPhaseCompleted(notification.item.phase, "Domykam odpowiedź."),
          Boolean(notification.item.phase),
        );
        return;
      default:
        return;
    }
  }

  private handleTurnPlanUpdated(notification: TurnPlanUpdatedNotification): void {
    const headline = sentenceFromPlan(notification.explanation, notification.plan, "Doprecyzowuję plan.");
    this.logProgressExtraction("turn/plan/updated", notification.turnId, {
      explanation: notification.explanation ?? null,
      firstPlanStep: notification.plan?.[0]?.step ?? null,
      activePlanStep: notification.plan?.find((step) => step.status === "in_progress")?.step ?? null,
      headline,
      informative: headline !== "Doprecyzowuję plan.",
      fallbackUsed: headline === "Doprecyzowuję plan.",
    });
    this.emitProgressEvent(notification.turnId, "plan", headline, headline !== "Doprecyzowuję plan.");
  }

  private handlePlanDelta(notification: PlanDeltaNotification): void {
    const headline = sentenceFromDelta(notification.delta, "Dopinam plan.");
    this.logProgressExtraction("item/plan/delta", notification.turnId, {
      delta: notification.delta,
      headline,
      informative: true,
      fallbackUsed: headline === "Dopinam plan.",
    });
    this.emitProgressEvent(notification.turnId, "plan", headline, true);
  }

  private handleMcpToolCallProgress(notification: McpToolCallProgressNotification): void {
    const headline = sentenceFromDelta(notification.message, "Narzędzie pracuje.");
    this.logProgressExtraction("item/mcpToolCall/progress", notification.turnId, {
      message: notification.message,
      headline,
      informative: true,
      fallbackUsed: headline === "Narzędzie pracuje.",
    });
    this.emitProgressEvent(notification.turnId, "tool", headline, true);
  }

  private handleReasoningTextDelta(notification: ReasoningTextDeltaNotification): void {
    const headline = sentenceFromDelta(notification.delta, "Nadal to analizuję.");
    this.logProgressExtraction("item/reasoning/textDelta", notification.turnId, {
      delta: notification.delta,
      contentIndex: notification.contentIndex,
      headline,
      informative: true,
      fallbackUsed: headline === "Nadal to analizuję.",
    });
    this.emitProgressEvent(notification.turnId, "reasoning", headline, true);
  }

  private handleContextCompacted(notification: ContextCompactedNotification): void {
    this.emitProgressEvent(notification.turnId, "plan", "Porządkuję kontekst.", false);
  }

  private handleHookStarted(notification: HookStartedNotification): void {
    if (!notification.turnId) {
      return;
    }

    const headline = sentenceFromHookRun(notification.run, "Odpalam pomocniczy krok.");
    this.logProgressExtraction("hook/started", notification.turnId, {
      eventName: notification.run?.eventName ?? null,
      statusMessage: notification.run?.statusMessage ?? null,
      sourcePath: notification.run?.sourcePath ?? null,
      headline,
      informative: headline !== "Odpalam pomocniczy krok.",
      fallbackUsed: headline === "Odpalam pomocniczy krok.",
    });
    this.emitProgressEvent(notification.turnId, "tool", headline, headline !== "Odpalam pomocniczy krok.");
  }

  private handleHookCompleted(notification: HookCompletedNotification): void {
    if (!notification.turnId) {
      return;
    }

    const headline = sentenceFromHookRun(notification.run, "Pomocniczy krok skończony.");
    this.logProgressExtraction("hook/completed", notification.turnId, {
      eventName: notification.run?.eventName ?? null,
      statusMessage: notification.run?.statusMessage ?? null,
      sourcePath: notification.run?.sourcePath ?? null,
      headline,
      informative: headline !== "Pomocniczy krok skończony.",
      fallbackUsed: headline === "Pomocniczy krok skończony.",
    });
    this.emitProgressEvent(notification.turnId, "tool", headline, headline !== "Pomocniczy krok skończony.");
  }

  private handleTurnDiffUpdated(notification: TurnDiffUpdatedNotification): void {
    const headline = sentenceFromDiff(notification.diff, "Zmieniam podejście do zmian.");
    this.logProgressExtraction("turn/diff/updated", notification.turnId, {
      diffPreview: notification.diff.slice(0, 240),
      headline,
      informative: headline !== "Zmieniam podejście do zmian.",
      fallbackUsed: headline === "Zmieniam podejście do zmian.",
    });
    this.emitProgressEvent(notification.turnId, "plan", headline, headline !== "Zmieniam podejście do zmian.");
  }

  private handleCommandExecutionOutputDelta(notification: CommandExecutionOutputDeltaNotification): void {
    const headline = sentenceFromDelta(notification.delta, "Polecenie jeszcze pracuje.");
    this.logProgressExtraction("item/commandExecution/outputDelta", notification.turnId, {
      delta: notification.delta,
      headline,
      informative: true,
      fallbackUsed: headline === "Polecenie jeszcze pracuje.",
    });
    this.emitProgressEvent(notification.turnId, "tool", headline, true);
  }

  private handleTerminalInteraction(notification: TerminalInteractionNotification): void {
    const headline = sentenceFromTerminalInput(notification.stdin, "Wchodzę w interakcję z terminalem.");
    this.logProgressExtraction("item/commandExecution/terminalInteraction", notification.turnId, {
      stdin: notification.stdin,
      processId: notification.processId,
      headline,
      informative: headline !== "Wchodzę w interakcję z terminalem.",
      fallbackUsed: headline === "Wchodzę w interakcję z terminalem.",
    });
    this.emitProgressEvent(notification.turnId, "tool", headline, headline !== "Wchodzę w interakcję z terminalem.");
  }

  private handleRawResponseItemCompleted(notification: RawResponseItemCompletedNotification): void {
    switch (notification.item.type) {
      case "reasoning":
        this.emitProgressEvent(notification.turnId, "reasoning", "Mam kolejny kawałek analizy.", false);
        return;
      case "local_shell_call":
      case "function_call":
      case "function_call_output":
      case "custom_tool_call":
      case "custom_tool_call_output":
      case "web_search_call":
      case "image_generation_call":
      case "ghost_snapshot":
        this.emitProgressEvent(notification.turnId, "tool", "Zapisuję stan pracy.", false);
        return;
      case "compaction":
        this.emitProgressEvent(notification.turnId, "plan", "Zwijam starszy kontekst.", false);
        return;
      default:
        return;
    }
  }

  private handleModelRerouted(notification: ModelReroutedNotification): void {
    const headline = sentenceFromModelReroute(notification, "Przełączam model do tego zadania.");
    this.logProgressExtraction("model/rerouted", notification.turnId, {
      fromModel: notification.fromModel,
      toModel: notification.toModel,
      reason: notification.reason ?? null,
      headline,
      informative: headline !== "Przełączam model do tego zadania.",
      fallbackUsed: headline === "Przełączam model do tego zadania.",
    });
    this.emitProgressEvent(notification.turnId, "plan", headline, headline !== "Przełączam model do tego zadania.");
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

  private emitProgressEvent(
    turnId: string,
    group: "start" | "reasoning" | "tool" | "plan",
    headline?: string,
    informative = false,
  ): void {
    const pending = this.pendingTurns.get(turnId);
    if (!pending?.stream?.onProgressEvent) {
      return;
    }

    this.logger.debug(`Emitting Codex progress event ${group} for turn ${turnId}`, {
      headline: headline ?? null,
      informative,
    });
    void Promise.resolve(pending.stream.onProgressEvent(group, headline, informative)).catch((error: unknown) => {
      this.logger.warn(`Failed to process progress event ${group} for turn ${turnId}`, error);
    });
  }

  private logProgressExtraction(method: string, turnId: string, meta: Record<string, unknown>): void {
    this.logger.debug(`Codex progress payload ${method} for turn ${turnId}`, meta);
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

function sentenceFromDelta(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return fallback;
  }

  const firstSentence = normalized.split(/(?<=[.!?])\s+/u, 1)[0]?.trim() || normalized;
  const cleaned = firstSentence
    .replace(/^[-*•\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return fallback;
  }

  const shortened = cleaned.length > 96 ? `${cleaned.slice(0, 95).trimEnd()}...` : cleaned;
  return /[.!?]$/.test(shortened) ? shortened : `${shortened}.`;
}

function sentenceFromPlan(
  explanation: string | null | undefined,
  plan: Array<{ step: string; status: string }> | undefined,
  fallback: string,
): string {
  if (explanation) {
    return sentenceFromDelta(explanation, fallback);
  }

  const activeStep = plan?.find((step) => step.status === "in_progress") ?? plan?.[0];
  if (!activeStep?.step) {
    return fallback;
  }

  return sentenceFromDelta(activeStep.step, fallback);
}

function sentenceFromCommand(command: string | undefined, fallback: string): string {
  if (!command) {
    return fallback;
  }

  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return fallback;
  }

  const shortCommand = normalized.length > 72 ? `${normalized.slice(0, 71).trimEnd()}...` : normalized;
  return sentenceFromDelta(`Uruchamiam: ${shortCommand}`, fallback);
}

function sentenceFromCommandCompleted(
  command: string | undefined,
  exitCode: number | null | undefined,
  fallback: string,
): string {
  if (!command) {
    return fallback;
  }

  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return fallback;
  }

  const shortCommand = normalized.length > 56 ? `${normalized.slice(0, 55).trimEnd()}...` : normalized;
  if (typeof exitCode === "number") {
    return sentenceFromDelta(`Kończę: ${shortCommand} z kodem ${exitCode}`, fallback);
  }

  return sentenceFromDelta(`Kończę: ${shortCommand}`, fallback);
}

function sentenceFromFileChanges(
  changes: Array<{ path?: string }> | undefined,
  fallback: string,
): string {
  const firstPath = changes?.find((change) => change.path)?.path;
  if (!firstPath) {
    return fallback;
  }

  return sentenceFromDelta(`Pracuję nad plikiem ${firstPath}`, fallback);
}

function sentenceFromAgentPhase(phase: string | undefined, fallback: string): string {
  switch (phase) {
    case "commentary":
      return "Układam odpowiedź.";
    case "final_answer":
      return "Składam odpowiedź końcową.";
    default:
      return fallback;
  }
}

function sentenceFromAgentPhaseCompleted(phase: string | undefined, fallback: string): string {
  switch (phase) {
    case "commentary":
      return "Komentarz gotowy.";
    case "final_answer":
      return "Odpowiedź domknięta.";
    default:
      return fallback;
  }
}

function sentenceFromHookRun(
  run:
    | {
        eventName?: string;
        statusMessage?: string | null;
        sourcePath?: string;
      }
    | undefined,
  fallback: string,
): string {
  if (!run) {
    return fallback;
  }

  if (run.statusMessage) {
    return sentenceFromDelta(run.statusMessage, fallback);
  }

  if (run.eventName) {
    return sentenceFromDelta(`Hook ${run.eventName}`, fallback);
  }

  if (run.sourcePath) {
    const sourceName = run.sourcePath.split(/[\\/]/u).at(-1) ?? run.sourcePath;
    return sentenceFromDelta(`Hook ${sourceName}`, fallback);
  }

  return fallback;
}

function sentenceFromDiff(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return fallback;
  }

  const fileMatch = normalized.match(/(?:---|\+\+\+)\s+[ab]\/([^\s]+)/u);
  if (fileMatch?.[1]) {
    return sentenceFromDelta(`Pracuję nad plikiem ${fileMatch[1]}`, fallback);
  }

  return fallback;
}

function sentenceFromTerminalInput(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return fallback;
  }

  return sentenceFromDelta(`W terminalu wpisuję: ${normalized}`, fallback);
}

function sentenceFromModelReroute(
  notification: {
    fromModel: string;
    toModel: string;
    reason?: string;
  },
  fallback: string,
): string {
  if (notification.reason === "highRiskCyberActivity") {
    return sentenceFromDelta(`Przełączam model ze względu na bardziej wrażliwe zadanie`, fallback);
  }

  if (notification.toModel && notification.fromModel && notification.toModel !== notification.fromModel) {
    return sentenceFromDelta(`Przełączam model z ${notification.fromModel} na ${notification.toModel}`, fallback);
  }

  return fallback;
}

function shouldLogCodexNotification(method: string): boolean {
  switch (method) {
    case "turn/started":
    case "item/started":
    case "item/completed":
    case "turn/plan/updated":
    case "item/plan/delta":
    case "item/mcpToolCall/progress":
    case "item/reasoning/textDelta":
    case "hook/started":
    case "hook/completed":
    case "turn/diff/updated":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "rawResponseItem/completed":
    case "model/rerouted":
    case "thread/compacted":
      return true;
    default:
      return false;
  }
}
