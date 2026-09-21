/**
 * Resolve Discord channel IDs that should receive process ops alerts.
 */

export type OpsChannelTarget = {
  channelId: string;
};

/**
 * Union env fallback with guild-configured ops channels; dedupe by channel id.
 */
export function resolveOpsAlertChannelIds(input: {
  envChannelId: string | undefined;
  guildChannelIds: string[];
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const candidates = [
    ...(input.envChannelId ? [input.envChannelId] : []),
    ...input.guildChannelIds,
  ];

  for (const raw of candidates) {
    const id = raw.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }

  return out;
}
