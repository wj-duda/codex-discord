export class CodexAttachedHintTurnCancelledError extends Error {
  readonly turnId: string;

  constructor(turnId: string) {
    super(`Codex attached hint for turn ${turnId} was cancelled because the active turn timed out`);
    this.name = "CodexAttachedHintTurnCancelledError";
    this.turnId = turnId;
  }
}
