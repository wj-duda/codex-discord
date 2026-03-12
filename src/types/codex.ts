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
  tokenUsage: ThreadTokenUsage | null;
  accountRateLimits: AccountRateLimitSnapshot | null;
}

export interface CodexTurnStreamHandlers {
  onSummaryDelta?(delta: string): void | Promise<void>;
  onSummaryPartAdded?(summaryIndex: number): void | Promise<void>;
}

export type ServerRequestDecision =
  | { decision: "decline" }
  | { decision: "cancel" }
  | { decision: "denied" }
  | { answers: Record<string, never> };
