import { describe, expect, it } from "vitest";

import { computeScheduledChoreNextRunAt, parseScheduledChoreFrequency } from "../src/chores/frequency.js";

describe("scheduled chore frequency parsing", () => {
  it("normalizes accepted minute, hour, and day intervals", () => {
    expect(parseScheduledChoreFrequency("15 minutes")).toMatchObject({
      value: 15,
      unit: "minute",
      normalized: "15minutes",
      intervalMs: 15 * 60_000,
    });
    expect(parseScheduledChoreFrequency("2hours")).toMatchObject({
      value: 2,
      unit: "hour",
      normalized: "2hours",
      intervalMs: 2 * 60 * 60_000,
    });
    expect(parseScheduledChoreFrequency("1day")).toMatchObject({
      value: 1,
      unit: "day",
      normalized: "1day",
      intervalMs: 24 * 60 * 60_000,
    });
  });

  it("rejects values outside the supported 1-30 range", () => {
    expect(() => parseScheduledChoreFrequency("0minutes")).toThrow(/1-30/i);
    expect(() => parseScheduledChoreFrequency("31days")).toThrow(/1-30/i);
    expect(() => parseScheduledChoreFrequency("weekly")).toThrow(/minute/i);
  });

  it("computes the next run from lastRunAt when available", () => {
    const nextRunAt = computeScheduledChoreNextRunAt({
      meta: {
        name: "Daily review",
        description: "Review the repo.",
        frequency: "1day",
        createdAt: "2026-03-01T00:00:00.000Z",
        lastRunAt: "2026-03-10T12:00:00.000Z",
      },
      frequency: parseScheduledChoreFrequency("1day"),
    });

    expect(nextRunAt.toISOString()).toBe("2026-03-11T12:00:00.000Z");
  });
});
