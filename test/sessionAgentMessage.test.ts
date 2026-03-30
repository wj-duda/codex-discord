import { describe, expect, it } from "vitest";

import {
  normalizeCompletedAgentMessageText,
  pickTurnResponseText,
  shouldExposeAgentMessageDetailInProgress,
} from "../src/codex/session.js";

describe("agent message response handling", () => {
  it("hides final_answer text from progress detail", () => {
    expect(shouldExposeAgentMessageDetailInProgress("final_answer")).toBe(false);
    expect(shouldExposeAgentMessageDetailInProgress("commentary")).toBe(true);
    expect(shouldExposeAgentMessageDetailInProgress(undefined)).toBe(true);
  });

  it("prefers completed final answer text over collected deltas", () => {
    expect(pickTurnResponseText("Final answer", ["commentary", "delta"])).toBe("Final answer");
  });

  it("falls back to collected response chunks when completed final answer text is missing", () => {
    expect(pickTurnResponseText(null, ["Final ", "answer"])).toBe("Final answer");
  });

  it("normalizes completed final answer text", () => {
    expect(normalizeCompletedAgentMessageText("  Final answer  ")).toBe("Final answer");
    expect(normalizeCompletedAgentMessageText("   ")).toBeNull();
    expect(normalizeCompletedAgentMessageText(undefined)).toBeNull();
  });
});
