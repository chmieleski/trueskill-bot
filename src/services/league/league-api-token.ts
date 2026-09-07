import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';

/** SHA-256 hex digest of a league API token plaintext. */
export function hashLeagueApiToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Create or rotate the league API token.
 * Persists only the hash; returns plaintext once for the caller to show ephemerally.
 */
export async function createOrRotateLeagueApiToken(leagueId: string): Promise<{
  plaintext: string;
  createdAt: Date;
}> {
  const plaintext = randomBytes(32).toString('base64url');
  const createdAt = new Date();
  await prisma.league.update({
    where: { id: leagueId },
    data: {
      apiTokenHash: hashLeagueApiToken(plaintext),
      apiTokenCreatedAt: createdAt,
    },
  });
  return { plaintext, createdAt };
}

/** Clear the stored league API token hash and created-at timestamp. */
export async function revokeLeagueApiToken(leagueId: string): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { apiTokenHash: null, apiTokenCreatedAt: null },
  });
}

export type LeagueApiTokenResolved = {
  leagueId: string;
  guildId: string;
  gameId: string;
  matchApprovalChannelId: string | undefined;
  status: 'ACTIVE' | 'ARCHIVED';
};

/**
 * Resolve a league from a bearer API token plaintext.
 * Returns null when the token is empty/whitespace or no league matches the hash.
 */
export async function resolveLeagueFromApiToken(
  plaintext: string,
): Promise<LeagueApiTokenResolved | null> {
  if (!plaintext.trim()) {
    return null;
  }

  const row = await prisma.league.findFirst({
    where: { apiTokenHash: hashLeagueApiToken(plaintext) },
    select: {
      id: true,
      guildId: true,
      gameId: true,
      matchApprovalChannelId: true,
      status: true,
    },
  });

  if (!row) {
    return null;
  }

  return {
    leagueId: row.id,
    guildId: row.guildId,
    gameId: row.gameId,
    matchApprovalChannelId: row.matchApprovalChannelId?.trim() || undefined,
    status: row.status,
  };
}
