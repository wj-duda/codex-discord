export type ScheduledChoreFrequencyUnit = "minute" | "hour" | "day";

export interface ParsedScheduledChoreFrequency {
  raw: string;
  normalized: string;
  value: number;
  unit: ScheduledChoreFrequencyUnit;
  intervalMs: number;
}

export interface ScheduledChoreMeta {
  name: string;
  description: string;
  frequency: string;
  createdAt: string;
  updatedAt?: string;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
}

export interface ScheduledChoreDefinition {
  guid: string;
  dirPath: string;
  metaPath: string;
  memoryPath: string;
  silentTurns: boolean;
  meta: ScheduledChoreMeta;
  frequency: ParsedScheduledChoreFrequency;
}

export interface CreateScheduledChoreInput {
  frequency: string;
  name: string;
  description: string;
}

export interface ScheduledChoreSummary {
  guid: string;
  name: string;
  descriptionPreview: string;
  frequency: string;
  silentTurns: boolean;
  intervalMs: number;
  createdAt: string;
  lastRunAt: string | null;
  nextRunAt: string;
}
