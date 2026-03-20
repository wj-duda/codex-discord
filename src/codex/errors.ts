export class CodexAttachedHintTurnCancelledError extends Error {
  readonly turnId: string;

  constructor(turnId: string) {
    super(`Codex attached hint for turn ${turnId} was cancelled because the active turn timed out`);
    this.name = "CodexAttachedHintTurnCancelledError";
    this.turnId = turnId;
  }
}

export class CodexSecondaryTurnCancelledError extends Error {
  readonly turnId: string;
  readonly primaryTurnId: string;

  constructor(turnId: string, primaryTurnId: string) {
    super(`Codex secondary turn ${turnId} was cancelled because primary turn ${primaryTurnId} timed out`);
    this.name = "CodexSecondaryTurnCancelledError";
    this.turnId = turnId;
    this.primaryTurnId = primaryTurnId;
  }
}
