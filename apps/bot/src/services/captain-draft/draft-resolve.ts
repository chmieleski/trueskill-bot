import { randomUUID } from 'node:crypto';
import type { Guild } from 'discord.js';
import { prisma } from '../../lib/prisma.js';
import { normalizeNick } from '../player/player-nick.js';
import type { DraftParticipant } from './draft-types.js';
import { CaptainDraftError } from './draft-types.js';

const MENTION_SEGMENT_RE = /<@!?(\d+)>/g;

type ParsedToken = { kind: 'mention'; discordId: string } | { kind: 'text'; label: string };

/** Split space- or comma-separated text into plain nick tokens. */
function parseTextSegments(text: string): ParsedToken[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((label) => ({ kind: 'text' as const, label }));
}

/**
 * Parse player input into mention or text tokens.
 * Discord mentions are extracted anywhere in the string (no comma required between them).
 * Remaining text is split on spaces or commas.
 */
function parseTokens(raw: string): ParsedToken[] {
  const tokens: ParsedToken[] = [];
  let lastIndex = 0;

  for (const match of raw.matchAll(MENTION_SEGMENT_RE)) {
    const before = raw.slice(lastIndex, match.index!).trim();
    if (before) {
      tokens.push(...parseTextSegments(before));
    }
    tokens.push({ kind: 'mention', discordId: match[1]! });
    lastIndex = match.index! + match[0].length;
  }

  const remaining = raw.slice(lastIndex).trim();
  if (remaining) {
    tokens.push(...parseTextSegments(remaining));
  }

  if (tokens.length === 0) {
    throw new CaptainDraftError('Player list cannot be empty.');
  }

  return tokens;
}

/** Resolve a guild member display label for a Discord mention. */
async function mentionLabel(guild: Guild, discordId: string): Promise<string> {
  try {
    const member = await guild.members.fetch(discordId);
    return member.displayName || member.user.username;
  } catch {
    return discordId;
  }
}

type LinkedPlayer = {
  username: string;
  discordId: string | null;
};

/** Batch lookup linked players by normalized nick for one game. */
async function lookupLinkedPlayersByNick(
  gameId: string,
  labels: string[],
): Promise<Map<string, LinkedPlayer>> {
  const normalizedLabels = [
    ...new Set(labels.map((label) => normalizeNick(label)).filter(Boolean)),
  ];
  if (normalizedLabels.length === 0) {
    return new Map();
  }

  const rows = await prisma.player.findMany({
    where: {
      gameId,
      OR: normalizedLabels.map((nick) => ({
        username: { equals: nick, mode: 'insensitive' as const },
      })),
    },
    select: { username: true, discordId: true },
  });

  const byNick = new Map<string, LinkedPlayer[]>();
  for (const row of rows) {
    const key = normalizeNick(row.username);
    const bucket = byNick.get(key) ?? [];
    bucket.push(row);
    byNick.set(key, bucket);
  }

  const resolved = new Map<string, LinkedPlayer>();
  for (const nick of normalizedLabels) {
    const matches = byNick.get(nick) ?? [];
    if (matches.length === 1) {
      resolved.set(nick, matches[0]!);
    }
  }

  return resolved;
}

function participantDedupeKey(participant: DraftParticipant): string {
  if (participant.discordId) {
    return `discord:${participant.discordId}`;
  }
  return `label:${normalizeNick(participant.label)}`;
}

/**
 * Parse a space- or comma-separated players string into draft participants.
 * Supports Discord mentions (no delimiter required between @s) and text nicks.
 * Links nicks via league gameId when set.
 */
export async function resolveParticipantsFromInput(input: {
  raw: string;
  gameId: string | null;
  guild: Guild;
}): Promise<DraftParticipant[]> {
  const tokens = parseTokens(input.raw);

  const mentionLabels = new Map<string, string>();
  for (const token of tokens) {
    if (token.kind === 'mention' && !mentionLabels.has(token.discordId)) {
      mentionLabels.set(token.discordId, await mentionLabel(input.guild, token.discordId));
    }
  }

  const textLabels = tokens
    .filter((token): token is Extract<ParsedToken, { kind: 'text' }> => token.kind === 'text')
    .map((token) => token.label);

  const linkedByNick =
    input.gameId != null
      ? await lookupLinkedPlayersByNick(input.gameId, textLabels)
      : new Map<string, LinkedPlayer>();

  const seen = new Set<string>();
  const participants: DraftParticipant[] = [];

  for (const token of tokens) {
    let participant: DraftParticipant;

    if (token.kind === 'mention') {
      participant = {
        key: randomUUID(),
        label: mentionLabels.get(token.discordId) ?? token.discordId,
        discordId: token.discordId,
      };
    } else {
      const linked = linkedByNick.get(normalizeNick(token.label));
      participant = {
        key: randomUUID(),
        label: linked?.username ?? token.label,
        ...(linked?.discordId ? { discordId: linked.discordId } : {}),
      };
    }

    const dedupeKey = participantDedupeKey(participant);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    participants.push(participant);
  }

  return participants;
}
