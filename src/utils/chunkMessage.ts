const DISCORD_LIMIT = 2000;

export function chunkMessage(message: string, maxLength = DISCORD_LIMIT): string[] {
  const normalized = message.trim();
  if (!normalized) {
    return ["(empty response)"];
  }

  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    const splitIndex = findSplitIndex(remaining, maxLength);
    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function findSplitIndex(value: string, maxLength: number): number {
  const preferredBreaks = ["\n\n", "\n", ". ", " "];

  for (const delimiter of preferredBreaks) {
    const index = value.lastIndexOf(delimiter, maxLength);
    if (index > maxLength / 2) {
      return index + delimiter.length;
    }
  }

  return maxLength;
}
