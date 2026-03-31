import type { ParsedScheduledChoreFrequency, ScheduledChoreDefinition, ScheduledChoreFrequencyUnit } from "./types.js";

const FREQUENCY_PATTERN = /^(?<value>[1-9]|[12]\d|30)\s*(?<unit>minutes?|hours?|days?)$/i;

const UNIT_MS: Record<ScheduledChoreFrequencyUnit, number> = {
  minute: 60_000,
  hour: 60 * 60_000,
  day: 24 * 60 * 60_000,
};

export function parseScheduledChoreFrequency(rawFrequency: string): ParsedScheduledChoreFrequency {
  const normalized = rawFrequency.trim().toLowerCase();
  const match = normalized.match(FREQUENCY_PATTERN);
  if (!match?.groups) {
    throw new Error("Frequency must use 1-30 with minute(s), hour(s), or day(s), for example 15minutes or 2hours.");
  }

  const value = Number.parseInt(match.groups.value ?? "", 10);
  if (!Number.isInteger(value) || value < 1 || value > 30) {
    throw new Error("Frequency value must be between 1 and 30.");
  }

  const rawUnit = match.groups.unit ?? "";
  const unit = normalizeFrequencyUnit(rawUnit);
  return {
    raw: rawFrequency,
    normalized: `${value}${unit}${value === 1 ? "" : "s"}`,
    value,
    unit,
    intervalMs: value * UNIT_MS[unit],
  };
}

export function computeScheduledChoreNextRunAt(task: Pick<ScheduledChoreDefinition, "meta" | "frequency">): Date {
  const baseTimestamp = parseTaskTimestamp(task.meta.lastRunAt) ?? parseTaskTimestamp(task.meta.createdAt) ?? Date.now();
  return new Date(baseTimestamp + task.frequency.intervalMs);
}

export function isScheduledChoreDue(
  task: Pick<ScheduledChoreDefinition, "meta" | "frequency">,
  now = Date.now(),
): boolean {
  return computeScheduledChoreNextRunAt(task).getTime() <= now;
}

function normalizeFrequencyUnit(rawUnit: string): ScheduledChoreFrequencyUnit {
  if (rawUnit.startsWith("minute")) {
    return "minute";
  }

  if (rawUnit.startsWith("hour")) {
    return "hour";
  }

  return "day";
}

function parseTaskTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
