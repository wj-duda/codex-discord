import type { AppConfig } from "../config/env.js";
import type {
  AccountRateLimitsUpdatedNotification,
  AccountRateLimitSnapshot,
  AgentMessageDeltaNotification,
  CodexProgressDetailFormat,
  CodexProgressGroup,
  CodexUserMessageDispatchResult,
  CodexUserMessageMode,
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
import { CodexAttachedHintTurnCancelledError, CodexSecondaryTurnCancelledError } from "./errors.js";
import { CodexThreadStore } from "./threadStore.js";
import { Logger } from "../utils/logger.js";

const CODEX_TURN_INACTIVITY_TIMEOUT_MS = 180_000;

interface PendingTurnWaiter {
  role: "primary" | "attached";
  stream?: CodexTurnStreamHandlers;
  resolve: (value: CodexTurnResult) => void;
  reject: (reason: Error) => void;
}

interface PendingTurn {
  turnId: string;
  createdAt: number;
  lastActivityAt: number;
  responseChunks: string[];
  finalResponseText: string | null;
  agentMessagePhases: Map<string, string | undefined>;
  attachments: string[];
  tokenUsage: ThreadTokenUsage | null;
  accountRateLimits: AccountRateLimitSnapshot | null;
  hasEmittedStartProgress: boolean;
  inactivityTimer: NodeJS.Timeout | null;
  waiters: PendingTurnWaiter[];
}

export class CodexSession {
  private readonly appServer: CodexAppServer;
  private readonly threadStore: CodexThreadStore;
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private accountRateLimits: AccountRateLimitSnapshot | null = null;
  private lastSessionActivityAt = 0;
  private threadId: string | null = null;
  private initialized = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.appServer = new CodexAppServer(logger, config.codexCwd);
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

  hasActiveTurns(): boolean {
    return this.pendingTurns.size > 0;
  }

  async sendUserMessage(
    message: string,
    stream?: CodexTurnStreamHandlers,
    mode: CodexUserMessageMode = "interactive",
  ): Promise<CodexUserMessageDispatchResult> {
    if (!this.threadId) {
      throw new Error("Codex session is not initialized");
    }

    if (typeof message !== "string" || !message.trim()) {
      throw new Error("Refusing to start a Codex turn with empty user input");
    }

    const fullMessage = this.composeUserMessage(message);
    const client = await this.appServer.start();
    const steeringHostTurnId = mode === "steering" ? this.findPrimaryPendingTurn()?.turnId ?? null : null;
    const turnResponse = await client.request<TurnStartResponse>("turn/start", {
      threadId: this.threadId,
      input: [
        {
          type: "text",
          text: fullMessage,
          text_elements: [],
        } satisfies UserTextInput,
      ],
    });

    const steeringHost = mode === "steering" ? this.resolveSteeringHost(turnResponse.turn.id, steeringHostTurnId) : null;
    if (steeringHost) {
      this.logger.info(`Treating turn ${turnResponse.turn.id} as steering for active turn ${steeringHost.turnId}`, {
        activePendingTurns: [...this.pendingTurns.keys()],
      });
      return {
        kind: "steering",
        turnId: turnResponse.turn.id,
        activeTurnId: steeringHost.turnId,
      };
    }

    const result = await new Promise<CodexTurnResult>((resolve, reject) => {
      const now = Date.now();
      this.lastSessionActivityAt = now;
      const waiter: PendingTurnWaiter = {
        role: "primary",
        stream,
        resolve,
        reject,
      };
      const existingPending = this.pendingTurns.get(turnResponse.turn.id);
      if (existingPending) {
        this.logger.info(`Codex returned active turn ${turnResponse.turn.id}; attaching another waiter`);
        const attachedWaiter: PendingTurnWaiter = {
          ...waiter,
          role: "attached",
        };
        existingPending.waiters.push(attachedWaiter);
        existingPending.accountRateLimits = this.accountRateLimits;
        if (existingPending.hasEmittedStartProgress) {
          this.emitProgressEventToWaiter(turnResponse.turn.id, attachedWaiter, "start", "Zaczynam.", false);
        } else {
          this.emitTurnStartedProgress(turnResponse.turn.id);
        }
        return;
      }

      this.pendingTurns.set(turnResponse.turn.id, {
        turnId: turnResponse.turn.id,
        createdAt: now,
        lastActivityAt: now,
        responseChunks: [],
        finalResponseText: null,
        agentMessagePhases: new Map(),
        attachments: [],
        tokenUsage: null,
        accountRateLimits: this.accountRateLimits,
        hasEmittedStartProgress: false,
        inactivityTimer: null,
        waiters: [waiter],
      });
      this.armTurnInactivityTimeout(turnResponse.turn.id);
      this.emitTurnStartedProgress(turnResponse.turn.id);
    });

    return {
      kind: "response",
      turnId: turnResponse.turn.id,
      result,
    };
  }

  async shutdown(): Promise<void> {
    await this.persistThreadId();
    for (const pending of this.pendingTurns.values()) {
      this.clearTurnInactivityTimeout(pending);
      this.rejectPendingTurn(pending, new Error("Codex session shut down"));
    }
    this.pendingTurns.clear();
    await this.appServer.stop();
  }

  private composeUserMessage(message: string): string {
    const prePrompt = this.config.codexPrePrompt?.trim();
    if (!prePrompt) {
      return message;
    }

    return `${prePrompt}\n\n${message}`;
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

    const turnId = extractTurnIdFromNotification(event.params);
    if (turnId) {
      this.noteTurnActivity(turnId);
      this.armTurnInactivityTimeout(turnId);
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

    if (pending.agentMessagePhases.get(notification.itemId) !== "final_answer") {
      return;
    }

    pending.responseChunks.push(notification.delta);
  }

  private handleReasoningSummaryDelta(notification: ReasoningSummaryTextDeltaNotification): void {
    const pending = this.pendingTurns.get(notification.turnId);
    if (!pending) {
      return;
    }

    for (const waiter of pending.waiters) {
      if (!waiter.stream?.onSummaryDelta) {
        continue;
      }

      void Promise.resolve(waiter.stream.onSummaryDelta(notification.delta)).catch((error: unknown) => {
        this.logger.warn(`Failed to process summary delta for turn ${notification.turnId}`, error);
      });
    }
  }

  private handleReasoningSummaryPartAdded(notification: ReasoningSummaryPartAddedNotification): void {
    const pending = this.pendingTurns.get(notification.turnId);
    if (!pending) {
      return;
    }

    for (const waiter of pending.waiters) {
      if (!waiter.stream?.onSummaryPartAdded) {
        continue;
      }

      void Promise.resolve(waiter.stream.onSummaryPartAdded(notification.summaryIndex)).catch((error: unknown) => {
        this.logger.warn(`Failed to process summary section for turn ${notification.turnId}`, error);
      });
    }
  }

  private handleTurnStarted(notification: TurnStartedNotification): void {
    this.emitTurnStartedProgress(notification.turn.id);
  }

  private handleItemStarted(notification: ItemStartedNotification): void {
    switch (notification.item.type) {
      case "plan":
        this.emitProgressEvent(notification.turnId, "plan", "I am building a plan.", false);
        return;
      case "reasoning":
        this.emitProgressEvent(notification.turnId, "reasoning", "I am analyzing this.", false);
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
          sentenceFromFileChanges(notification.item.changes, "Preparing file changes."),
          Boolean(notification.item.changes?.[0]?.path),
        );
        return;
      case "mcpToolCall":
        this.emitProgressEvent(notification.turnId, "tool", "Starting a tool.", false);
        return;
      case "dynamicToolCall":
        this.emitProgressEvent(notification.turnId, "tool", "Running a tool.", false);
        return;
      case "collabAgentToolCall":
        this.emitProgressEvent(notification.turnId, "tool", "Starting another tool.", false);
        return;
      case "webSearch":
        this.emitProgressEvent(notification.turnId, "tool", "Sprawdzam to w sieci.", false);
        return;
      case "imageView":
        this.emitProgressEvent(notification.turnId, "tool", "Looking at the image.", false);
        return;
      case "imageGeneration":
        this.emitProgressEvent(notification.turnId, "tool", "Preparing the image.", false);
        return;
      case "agentMessage":
        {
          if (notification.item.id) {
            pendingAgentMessagePhase(this.pendingTurns.get(notification.turnId), notification.item.id, notification.item.phase);
          }
          const detail = shouldExposeAgentMessageDetailInProgress(notification.item.phase)
            ? detailFromText(notification.item.text ?? "")
            : undefined;
          const informative = shouldExposeAgentMessageDetailInProgress(notification.item.phase) && Boolean(detail);
          this.emitProgressEvent(
            notification.turnId,
            notification.item.phase === "final_answer" ? "plan" : "reasoning",
            sentenceFromAgentPhase(notification.item.phase, "Composing the response."),
            informative,
            detail,
            "plain",
          );
          return;
        }
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
        this.emitProgressEvent(notification.turnId, "reasoning", "I have an outline now.", false);
        return;
      case "commandExecution":
        this.emitProgressEvent(
          notification.turnId,
          "tool",
          sentenceFromCommandCompleted(notification.item.command, notification.item.exitCode, "Command completed."),
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
        this.emitProgressEvent(notification.turnId, "tool", "The tool finished.", false);
        return;
      case "dynamicToolCall":
        this.emitProgressEvent(notification.turnId, "tool", "The tool returned.", false);
        return;
      case "collabAgentToolCall":
        this.emitProgressEvent(notification.turnId, "tool", "The extra tool returned.", false);
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
        {
          const pending = this.pendingTurns.get(notification.turnId);
          if (notification.item.id) {
            pendingAgentMessagePhase(pending, notification.item.id, notification.item.phase);
          }
          if (notification.item.phase === "final_answer") {
            const finalText = normalizeCompletedAgentMessageText(notification.item.text);
            if (pending && finalText) {
              pending.finalResponseText = finalText;
            }
          }
          const detail = shouldExposeAgentMessageDetailInProgress(notification.item.phase)
            ? detailFromText(notification.item.text ?? "")
            : undefined;
          const informative = shouldExposeAgentMessageDetailInProgress(notification.item.phase) && Boolean(detail);
          this.emitProgressEvent(
            notification.turnId,
            notification.item.phase === "final_answer" ? "plan" : "reasoning",
            sentenceFromAgentPhaseCompleted(notification.item.phase, "Wrapping up the response."),
            informative,
            detail,
            "plain",
          );
          return;
        }
      default:
        return;
    }
  }

  private handleTurnPlanUpdated(notification: TurnPlanUpdatedNotification): void {
    const headline = sentenceFromPlan(notification.explanation, notification.plan, "Refining the plan.");
    const detail = detailFromPlan(notification.explanation, notification.plan);
    this.logProgressExtraction("turn/plan/updated", notification.turnId, {
      explanation: notification.explanation ?? null,
      firstPlanStep: notification.plan?.[0]?.step ?? null,
      activePlanStep: notification.plan?.find((step) => step.status === "in_progress")?.step ?? null,
      headline,
      detail,
      informative: headline !== "Refining the plan.",
      fallbackUsed: headline === "Refining the plan.",
    });
    this.emitProgressEvent(notification.turnId, "plan", headline, headline !== "Refining the plan.", detail);
  }

  private handlePlanDelta(notification: PlanDeltaNotification): void {
    const fallback = "Dopinam plan.";
    const headline = sentenceFromDelta(notification.delta, fallback);
    const detail = detailFromText(notification.delta);
    const informative = headline !== fallback;
    this.logProgressExtraction("item/plan/delta", notification.turnId, {
      delta: notification.delta,
      headline,
      detail,
      informative,
      fallbackUsed: !informative,
    });
    this.emitProgressEvent(notification.turnId, "plan", headline, informative, detail);
  }

  private handleMcpToolCallProgress(notification: McpToolCallProgressNotification): void {
    const fallback = "The tool is working.";
    const headline = sentenceFromDelta(notification.message, fallback);
    const detail = detailFromText(notification.message);
    const informative = headline !== fallback;
    this.logProgressExtraction("item/mcpToolCall/progress", notification.turnId, {
      message: notification.message,
      headline,
      detail,
      informative,
      fallbackUsed: !informative,
    });
    this.emitProgressEvent(notification.turnId, "tool", headline, informative, detail);
  }

  private handleReasoningTextDelta(notification: ReasoningTextDeltaNotification): void {
    const fallback = "Still analyzing this.";
    const headline = sentenceFromDelta(notification.delta, fallback);
    const detail = detailFromText(notification.delta);
    const informative = headline !== fallback;
    this.logProgressExtraction("item/reasoning/textDelta", notification.turnId, {
      delta: notification.delta,
      contentIndex: notification.contentIndex,
      headline,
      detail,
      informative,
      fallbackUsed: !informative,
    });
    this.emitProgressEvent(notification.turnId, "reasoning", headline, informative, detail);
  }

  private handleContextCompacted(notification: ContextCompactedNotification): void {
    this.emitProgressEvent(notification.turnId, "plan", "Organizing the context.", false);
  }

  private handleHookStarted(notification: HookStartedNotification): void {
    if (!notification.turnId) {
      return;
    }

    const headline = sentenceFromHookRun(notification.run, "Odpalam pomocniczy krok.");
    const detail = detailFromHookRun(notification.run);
    this.logProgressExtraction("hook/started", notification.turnId, {
      eventName: notification.run?.eventName ?? null,
      statusMessage: notification.run?.statusMessage ?? null,
      sourcePath: notification.run?.sourcePath ?? null,
      headline,
      detail,
      informative: headline !== "Odpalam pomocniczy krok.",
      fallbackUsed: headline === "Odpalam pomocniczy krok.",
    });
    this.emitProgressEvent(
      notification.turnId,
      "tool",
      headline,
      headline !== "Odpalam pomocniczy krok.",
      detail,
    );
  }

  private handleHookCompleted(notification: HookCompletedNotification): void {
    if (!notification.turnId) {
      return;
    }

    const headline = sentenceFromHookRun(notification.run, "Helper step completed.");
    const detail = detailFromHookRun(notification.run);
    this.logProgressExtraction("hook/completed", notification.turnId, {
      eventName: notification.run?.eventName ?? null,
      statusMessage: notification.run?.statusMessage ?? null,
      sourcePath: notification.run?.sourcePath ?? null,
      headline,
      detail,
      informative: headline !== "Helper step completed.",
      fallbackUsed: headline === "Helper step completed.",
    });
    this.emitProgressEvent(notification.turnId, "tool", headline, headline !== "Helper step completed.", detail);
  }

  private handleTurnDiffUpdated(notification: TurnDiffUpdatedNotification): void {
    const headline = sentenceFromDiff(notification.diff, "Adjusting the change approach.");
    const detail = detailFromDiff(notification.diff);
    this.logProgressExtraction("turn/diff/updated", notification.turnId, {
      diffPreview: notification.diff.slice(0, 240),
      headline,
      detail,
      informative: headline !== "Adjusting the change approach.",
      fallbackUsed: headline === "Adjusting the change approach.",
    });
    this.emitProgressEvent(notification.turnId, "plan", headline, headline !== "Adjusting the change approach.", detail);
  }

  private handleCommandExecutionOutputDelta(notification: CommandExecutionOutputDeltaNotification): void {
    const fallback = "Polecenie jeszcze pracuje.";
    const headline = sentenceFromDelta(notification.delta, fallback);
    const detail = detailFromCommandOutput(notification.delta);
    const informative = headline !== fallback;
    this.logProgressExtraction("item/commandExecution/outputDelta", notification.turnId, {
      delta: notification.delta,
      headline,
      detail,
      informative,
      fallbackUsed: !informative,
    });
    this.emitProgressEvent(notification.turnId, "tool", headline, informative, detail);
  }

  private handleTerminalInteraction(notification: TerminalInteractionNotification): void {
    const headline = sentenceFromTerminalInput(notification.stdin, "Interacting with the terminal.");
    const detail = detailFromTerminalInput(notification.stdin);
    this.logProgressExtraction("item/commandExecution/terminalInteraction", notification.turnId, {
      stdin: notification.stdin,
      processId: notification.processId,
      headline,
      detail,
      informative: headline !== "Interacting with the terminal.",
      fallbackUsed: headline === "Interacting with the terminal.",
    });
    this.emitProgressEvent(notification.turnId, "tool", headline, headline !== "Interacting with the terminal.", detail);
  }

  private handleRawResponseItemCompleted(notification: RawResponseItemCompletedNotification): void {
    this.captureRawResponseAttachment(notification);

    switch (notification.item.type) {
      case "reasoning":
        this.emitProgressEvent(notification.turnId, "reasoning", "I have another piece of the analysis.", false);
        return;
      case "local_shell_call":
      case "function_call":
      case "function_call_output":
      case "custom_tool_call":
      case "custom_tool_call_output":
      case "web_search_call":
      case "image_generation_call":
      case "ghost_snapshot":
        this.emitProgressEvent(notification.turnId, "tool", "Saving the work state.", false);
        return;
      case "compaction":
        this.emitProgressEvent(notification.turnId, "plan", "Zwijam starszy kontekst.", false);
        return;
      default:
        return;
    }
  }

  private handleModelRerouted(notification: ModelReroutedNotification): void {
    const headline = sentenceFromModelReroute(notification, "Switching the model for this task.");
    this.logProgressExtraction("model/rerouted", notification.turnId, {
      fromModel: notification.fromModel,
      toModel: notification.toModel,
      reason: notification.reason ?? null,
      headline,
      informative: headline !== "Switching the model for this task.",
      fallbackUsed: headline === "Switching the model for this task.",
    });
    this.emitProgressEvent(notification.turnId, "plan", headline, headline !== "Switching the model for this task.");
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

  private resolvePendingTurn(pending: PendingTurn, result: CodexTurnResult): void {
    for (const waiter of pending.waiters) {
      waiter.resolve(result);
    }
  }

  private rejectPendingTurn(pending: PendingTurn, error: Error): void {
    for (const waiter of pending.waiters) {
      waiter.reject(error);
    }
  }

  private handleTurnCompleted(notification: TurnCompletedNotification): void {
    const pending = this.pendingTurns.get(notification.turn.id);
    if (!pending) {
      return;
    }

    this.pendingTurns.delete(notification.turn.id);
    this.clearTurnInactivityTimeout(pending);

    if (notification.turn.status === "failed") {
      this.rejectPendingTurn(pending, new Error(notification.turn.error?.message || "Codex turn failed"));
      return;
    }

    const response = pickTurnResponseText(pending.finalResponseText, pending.responseChunks);
    this.resolvePendingTurn(pending, {
      response: response || "(empty response)",
      attachments: [...pending.attachments],
      tokenUsage: pending.tokenUsage,
      accountRateLimits: pending.accountRateLimits,
    });
  }

  private captureRawResponseAttachment(notification: RawResponseItemCompletedNotification): void {
    const pending = this.pendingTurns.get(notification.turnId);
    if (!pending) {
      return;
    }

    if (notification.item.type !== "image_generation_call") {
      return;
    }

    const savedPath = notification.item.saved_path?.trim();
    if (!savedPath) {
      return;
    }

    if (pending.attachments.includes(savedPath)) {
      return;
    }

    pending.attachments.push(savedPath);
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
    this.clearTurnInactivityTimeout(pending);
    this.rejectPendingTurn(pending, new Error(notification.error.message || "Codex turn failed"));
  }

  private emitProgressEvent(
    turnId: string,
    group: CodexProgressGroup,
    headline?: string,
    informative = false,
    detail?: string,
    detailFormat: CodexProgressDetailFormat = "code",
  ): void {
    const pending = this.pendingTurns.get(turnId);
    if (!pending) {
      return;
    }

    this.logger.debug(`Emitting Codex progress event ${group} for turn ${turnId}`, {
      headline: headline ?? null,
      detail: detail ?? null,
      detailFormat,
      informative,
    });
    this.emitProgressEventToWaiters(turnId, pending.waiters, group, headline, informative, detail, detailFormat);
  }

  private emitTurnStartedProgress(turnId: string): void {
    const pending = this.pendingTurns.get(turnId);
    if (!pending || pending.hasEmittedStartProgress) {
      return;
    }

    pending.hasEmittedStartProgress = true;
    this.emitProgressEventToWaiters(turnId, pending.waiters, "start", "Zaczynam.", false);
  }

  private emitProgressEventToWaiters(
    turnId: string,
    waiters: PendingTurnWaiter[],
    group: CodexProgressGroup,
    headline?: string,
    informative = false,
    detail?: string,
    detailFormat: CodexProgressDetailFormat = "code",
  ): void {
    for (const waiter of waiters) {
      this.emitProgressEventToWaiter(turnId, waiter, group, headline, informative, detail, detailFormat);
    }
  }

  private emitProgressEventToWaiter(
    turnId: string,
    waiter: PendingTurnWaiter,
    group: CodexProgressGroup,
    headline?: string,
    informative = false,
    detail?: string,
    detailFormat: CodexProgressDetailFormat = "code",
  ): void {
    if (!waiter.stream?.onProgressEvent) {
      return;
    }

    void Promise.resolve(waiter.stream.onProgressEvent({ group, headline, detail, detailFormat, informative })).catch(
      (error: unknown) => {
        this.logger.warn(`Failed to process progress event ${group} for turn ${turnId}`, error);
      },
    );
  }

  private armTurnInactivityTimeout(turnId: string): void {
    const pending = this.pendingTurns.get(turnId);
    if (!pending) {
      return;
    }

    this.clearTurnInactivityTimeout(pending);
    pending.inactivityTimer = setTimeout(() => {
      this.handleTurnInactivityTimeout(turnId);
    }, CODEX_TURN_INACTIVITY_TIMEOUT_MS);
    pending.inactivityTimer.unref?.();
  }

  private noteTurnActivity(turnId: string): void {
    const now = Date.now();
    this.lastSessionActivityAt = now;

    const pending = this.pendingTurns.get(turnId);
    if (!pending) {
      return;
    }

    pending.lastActivityAt = now;
  }

  private handleTurnInactivityTimeout(turnId: string): void {
    const pending = this.pendingTurns.get(turnId);
    if (!pending) {
      return;
    }

    const now = Date.now();
    const sessionIdleMs = now - this.lastSessionActivityAt;
    if (sessionIdleMs < CODEX_TURN_INACTIVITY_TIMEOUT_MS) {
      this.logger.debug(`Skipping inactivity timeout for turn ${turnId} because another turn is still active`, {
        timeoutMs: CODEX_TURN_INACTIVITY_TIMEOUT_MS,
        sessionIdleMs,
        pendingTurns: [...this.pendingTurns.keys()],
      });
      this.armTurnInactivityTimeout(turnId);
      return;
    }

    const primaryPending = this.findPrimaryPendingTurn();
    const timeoutError = new Error(
      `Codex turn timed out after ${Math.round(CODEX_TURN_INACTIVITY_TIMEOUT_MS / 1000)} seconds of inactivity`,
    );

    if (!primaryPending) {
      this.pendingTurns.delete(turnId);
      this.clearTurnInactivityTimeout(pending);
      this.rejectPendingTurn(pending, timeoutError);
      return;
    }

    const pendingTurns = [...this.pendingTurns.values()];
    for (const activePending of pendingTurns) {
      this.pendingTurns.delete(activePending.turnId);
      this.clearTurnInactivityTimeout(activePending);
    }

    this.logger.warn(`Codex session timed out after inactivity`, {
      timeoutMs: CODEX_TURN_INACTIVITY_TIMEOUT_MS,
      sessionIdleMs,
      primaryTurnId: primaryPending.turnId,
      timedOutTurns: pendingTurns.map((activePending) => ({
        turnId: activePending.turnId,
        createdAt: new Date(activePending.createdAt).toISOString(),
        lastActivityAt: new Date(activePending.lastActivityAt).toISOString(),
        waiters: activePending.waiters.length,
      })),
    });

    this.rejectPrimaryPendingTurnOnTimeout(primaryPending, timeoutError);
    for (const activePending of pendingTurns) {
      if (activePending.turnId === primaryPending.turnId) {
        continue;
      }

      this.rejectPendingTurn(activePending, new CodexSecondaryTurnCancelledError(activePending.turnId, primaryPending.turnId));
    }
  }

  private findPrimaryPendingTurn(): PendingTurn | null {
    let primaryPending: PendingTurn | null = null;
    for (const pending of this.pendingTurns.values()) {
      if (!primaryPending || pending.createdAt < primaryPending.createdAt) {
        primaryPending = pending;
      }
    }

    return primaryPending;
  }

  private resolveSteeringHost(turnId: string, fallbackTurnId: string | null): PendingTurn | null {
    const matchingTurn = this.pendingTurns.get(turnId);
    if (matchingTurn) {
      return matchingTurn;
    }

    if (fallbackTurnId) {
      const fallbackTurn = this.pendingTurns.get(fallbackTurnId);
      if (fallbackTurn) {
        return fallbackTurn;
      }
    }

    return this.findPrimaryPendingTurn();
  }

  private rejectPrimaryPendingTurnOnTimeout(pending: PendingTurn, timeoutError: Error): void {
    const primaryWaiters = pending.waiters.filter((waiter) => waiter.role === "primary");
    const attachedWaiters = pending.waiters.filter((waiter) => waiter.role === "attached");
    if (primaryWaiters.length === 0) {
      this.rejectPendingTurn(pending, timeoutError);
      return;
    }

    for (const waiter of primaryWaiters) {
      waiter.reject(timeoutError);
    }

    for (const waiter of attachedWaiters) {
      waiter.reject(new CodexAttachedHintTurnCancelledError(pending.turnId));
    }
  }

  private clearTurnInactivityTimeout(pending: PendingTurn): void {
    if (!pending.inactivityTimer) {
      return;
    }

    clearTimeout(pending.inactivityTimer);
    pending.inactivityTimer = null;
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

function detailFromText(value: string, maxLength = 320): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }

  const cleaned = normalized
    .replace(/^[-*•\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return undefined;
  }

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, maxLength - 1).trimEnd()}...`;
}

function pendingAgentMessagePhase(
  pending: PendingTurn | undefined,
  itemId: string,
  phase: string | undefined,
): void {
  if (!pending) {
    return;
  }

  pending.agentMessagePhases.set(itemId, phase);
}

export function shouldExposeAgentMessageDetailInProgress(phase: string | undefined): boolean {
  return phase !== "final_answer";
}

export function normalizeCompletedAgentMessageText(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function pickTurnResponseText(finalResponseText: string | null | undefined, responseChunks: string[]): string {
  return finalResponseText?.trim() || responseChunks.join("").trim();
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

function detailFromPlan(
  explanation: string | null | undefined,
  plan: Array<{ step: string; status: string }> | undefined,
): string | undefined {
  if (explanation) {
    return detailFromText(explanation);
  }

  const activeStep = plan?.find((step) => step.status === "in_progress") ?? plan?.[0];
  if (!activeStep?.step) {
    return undefined;
  }

  return detailFromText(activeStep.step);
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
    return sentenceFromDelta(`Finishing: ${shortCommand} with exit code ${exitCode}`, fallback);
  }

  return sentenceFromDelta(`Finishing: ${shortCommand}`, fallback);
}

function sentenceFromFileChanges(
  changes: Array<{ path?: string }> | undefined,
  fallback: string,
): string {
  const firstPath = changes?.find((change) => change.path)?.path;
  if (!firstPath) {
    return fallback;
  }

  return sentenceFromDelta(`Working on file ${firstPath}`, fallback);
}

function sentenceFromAgentPhase(phase: string | undefined, fallback: string): string {
  switch (phase) {
    case "commentary":
      return "Composing the response.";
    case "final_answer":
      return "Composing the final response.";
    default:
      return fallback;
  }
}

function sentenceFromAgentPhaseCompleted(phase: string | undefined, fallback: string): string {
  switch (phase) {
    case "commentary":
      return "Komentarz gotowy.";
    case "final_answer":
      return "Response completed.";
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

function detailFromHookRun(
  run:
    | {
        eventName?: string;
        statusMessage?: string | null;
        sourcePath?: string;
      }
    | undefined,
): string | undefined {
  if (!run) {
    return undefined;
  }

  if (run.statusMessage) {
    return detailFromText(run.statusMessage);
  }

  if (run.eventName) {
    return detailFromText(`Hook ${run.eventName}`);
  }

  if (run.sourcePath) {
    const sourceName = run.sourcePath.split(/[\\/]/u).at(-1) ?? run.sourcePath;
    return detailFromText(`Hook ${sourceName}`);
  }

  return undefined;
}

function sentenceFromDiff(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return fallback;
  }

  const fileMatch = normalized.match(/(?:---|\+\+\+)\s+[ab]\/([^\s]+)/u);
  if (fileMatch?.[1]) {
    return sentenceFromDelta(`Working on file ${fileMatch[1]}`, fallback);
  }

  return fallback;
}

function detailFromDiff(value: string): string | undefined {
  return detailFromText(value, 240);
}

function detailFromCommandOutput(value: string): string | undefined {
  const detail = detailFromText(value, 240);
  if (!detail) {
    return undefined;
  }

  if (/^[`$#>]/u.test(detail)) {
    return undefined;
  }

  return detail;
}

function sentenceFromTerminalInput(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return fallback;
  }

  return sentenceFromDelta(`Typing into the terminal: ${normalized}`, fallback);
}

function detailFromTerminalInput(value: string): string | undefined {
  return detailFromText(`Typing into the terminal: ${value}`, 240);
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
    return sentenceFromDelta(`Switching the model because the task is more sensitive`, fallback);
  }

  if (notification.toModel && notification.fromModel && notification.toModel !== notification.fromModel) {
    return sentenceFromDelta(`Switching the model from ${notification.fromModel} to ${notification.toModel}`, fallback);
  }

  return fallback;
}

function extractTurnIdFromNotification(params: unknown): string | null {
  if (!params || typeof params !== "object") {
    return null;
  }

  const record = params as Record<string, unknown>;
  if (typeof record.turnId === "string" && record.turnId.trim()) {
    return record.turnId;
  }

  const turn = record.turn;
  if (!turn || typeof turn !== "object") {
    return null;
  }

  const turnId = (turn as Record<string, unknown>).id;
  return typeof turnId === "string" && turnId.trim() ? turnId : null;
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
