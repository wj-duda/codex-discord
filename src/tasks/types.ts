export type ScheduledTaskFrequencyUnit = "minute" | "hour" | "day";

export interface ParsedScheduledTaskFrequency {
  raw: string;
  normalized: string;
  value: number;
  unit: ScheduledTaskFrequencyUnit;
  intervalMs: number;
}

export interface ScheduledTaskMeta {
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

export interface ScheduledTaskDefinition {
  guid: string;
  dirPath: string;
  metaPath: string;
  memoryPath: string;
  silentTurns: boolean;
  meta: ScheduledTaskMeta;
  frequency: ParsedScheduledTaskFrequency;
}

export interface CreateScheduledTaskInput {
  frequency: string;
  name: string;
  description: string;
}

export interface ScheduledTaskSummary {
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
