export interface InitializeResponse {
  userAgent: string;
}

export interface ThreadStartResponse {
  thread: {
    id: string;
  };
}

export interface ThreadResumeResponse {
  thread: {
    id: string;
  };
}

export interface TurnStartResponse {
  turn: {
    id: string;
  };
}

export interface UserTextInput {
  type: "text";
  text: string;
  text_elements: [];
}

export interface AgentMessageDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface AccountRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface AccountRateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: AccountRateLimitWindow | null;
  secondary: AccountRateLimitWindow | null;
}

export interface AccountRateLimitsUpdatedNotification {
  rateLimits: AccountRateLimitSnapshot;
}

export interface GetAccountRateLimitsResponse {
  rateLimits: AccountRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, AccountRateLimitSnapshot> | null;
}

export interface ThreadTokenUsageUpdatedNotification {
  threadId: string;
  turnId: string;
  tokenUsage: ThreadTokenUsage;
}

export interface ReasoningSummaryTextDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
  summaryIndex: number;
}

export interface ReasoningSummaryPartAddedNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  summaryIndex: number;
}

export interface TurnStartedNotification {
  threadId: string;
  turn: {
    id: string;
    status: string;
  };
}

export interface ItemStartedNotification {
  threadId: string;
  turnId: string;
  item: {
    id: string;
    type: string;
    command?: string;
    phase?: string;
    changes?: Array<{
      path?: string;
    }>;
  };
}

export interface ItemCompletedNotification {
  threadId: string;
  turnId: string;
  item: {
    id: string;
    type: string;
    command?: string;
    phase?: string;
    changes?: Array<{
      path?: string;
    }>;
    exitCode?: number | null;
  };
}

export interface TurnPlanUpdatedNotification {
  threadId: string;
  turnId: string;
  explanation?: string | null;
  plan?: Array<{
    step: string;
    status: string;
  }>;
}

export interface PlanDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface McpToolCallProgressNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  message: string;
}

export interface ReasoningTextDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
  contentIndex: number;
}

export interface ContextCompactedNotification {
  threadId: string;
  turnId: string;
}

export interface HookStartedNotification {
  threadId: string;
  turnId: string | null;
  run?: {
    eventName?: string;
    statusMessage?: string | null;
    sourcePath?: string;
  };
}

export interface HookCompletedNotification {
  threadId: string;
  turnId: string | null;
  run?: {
    eventName?: string;
    statusMessage?: string | null;
    sourcePath?: string;
  };
}

export interface TurnDiffUpdatedNotification {
  threadId: string;
  turnId: string;
  diff: string;
}

export interface ModelReroutedNotification {
  threadId: string;
  turnId: string;
  fromModel: string;
  toModel: string;
  reason?: string;
}

export interface CommandExecutionOutputDeltaNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface TerminalInteractionNotification {
  threadId: string;
  turnId: string;
  itemId: string;
  processId: string;
  stdin: string;
}

export interface RawResponseItemCompletedNotification {
  threadId: string;
  turnId: string;
  item: {
    id?: string;
    type: string;
    result?: string;
    saved_path?: string | null;
  };
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: {
    id: string;
    status: string;
    error: {
      message?: string;
    } | null;
  };
}

export interface ErrorNotification {
  error: {
    message?: string;
  };
  willRetry: boolean;
  threadId: string;
  turnId: string;
}

export interface CodexTurnResult {
  response: string;
  attachments: string[];
  tokenUsage: ThreadTokenUsage | null;
  accountRateLimits: AccountRateLimitSnapshot | null;
}

export type CodexProgressGroup = "start" | "reasoning" | "tool" | "plan";

export interface CodexProgressEvent {
  group: CodexProgressGroup;
  headline?: string;
  detail?: string;
  informative?: boolean;
}

export interface CodexTurnStreamHandlers {
  onSummaryDelta?(delta: string): void | Promise<void>;
  onSummaryPartAdded?(summaryIndex: number): void | Promise<void>;
  onProgressEvent?(event: CodexProgressEvent): void | Promise<void>;
}

export type ServerRequestDecision =
  | { decision: "decline" }
  | { decision: "cancel" }
  | { decision: "denied" }
  | { answers: Record<string, never> };
