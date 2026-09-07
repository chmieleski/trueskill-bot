import { prisma } from '../../lib/prisma.js';
import { isLeagueWritable, LEAGUE_ARCHIVED_MESSAGE } from '../league/league.js';
import { assertHasMatchModRole } from '../match/match-auth.js';

export const RANK_RESET_COOLDOWN_MIN_DAYS = 1;
export const RANK_RESET_COOLDOWN_MAX_DAYS = 365;
export const RANK_RESET_COOLDOWN_DEFAULT_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const RANK_RESET_CUSTOM_ID_PREFIX = 'rr';
const RANK_RESET_CONFIRM_ACTION = 'c';
const RANK_RESET_CANCEL_ACTION = 'x';

export class RankResetServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RankResetServiceError';
  }
}

export type PreviewRankResetInput = {
  leagueId: string;
  actorDiscordId: string;
  targetDiscordId: string;
  memberRoleIds: string[];
  matchModRoleId?: string;
  now?: Date;
};

export type RankResetPreview = {
  leagueId: string;
  playerId: string;
  username: string;
  targetDiscordId: string;
  staffOverride: boolean;
  cooldownDays: number;
};

export type ApplyRankResetInput = PreviewRankResetInput & {
  expectedPlayerId?: string;
};

export type RankResetResult = {
  playerId: string;
  username: string;
  staffOverride: boolean;
};

export type RankResetButtonAction = 'confirm' | 'cancel';

export type ParsedRankResetButtonCustomId = {
  action: RankResetButtonAction;
  leagueId: string;
  playerId: string;
  actorDiscordId: string;
};

/** Validate and return a league's rank-reset cooldown in days. */
export function assertRankResetCooldownDays(days: number): number {
  if (
    !Number.isInteger(days) ||
    days < RANK_RESET_COOLDOWN_MIN_DAYS ||
    days > RANK_RESET_COOLDOWN_MAX_DAYS
  ) {
    throw new RankResetServiceError('Rank reset cooldown must be between 1 and 365 days.');
  }
  return days;
}

/** Return the first instant at which another self reset is allowed. */
export function nextRankResetAt(lastResetAt: Date, cooldownDays: number): Date {
  const safeCooldownDays = assertRankResetCooldownDays(cooldownDays);
  return new Date(lastResetAt.getTime() + safeCooldownDays * DAY_MS);
}

/** Check whether the player's rank-reset cooldown has elapsed. */
export function isRankResetCooldownElapsed(
  lastResetAt: Date,
  cooldownDays: number,
  now = new Date(),
): boolean {
  return now.getTime() >= nextRankResetAt(lastResetAt, cooldownDays).getTime();
}

function rankResetActionCode(action: RankResetButtonAction): string {
  return action === 'confirm' ? RANK_RESET_CONFIRM_ACTION : RANK_RESET_CANCEL_ACTION;
}

function parseRankResetActionCode(actionCode: string): RankResetButtonAction | null {
  if (actionCode === RANK_RESET_CONFIRM_ACTION) {
    return 'confirm';
  }
  if (actionCode === RANK_RESET_CANCEL_ACTION) {
    return 'cancel';
  }
  return null;
}

function buildRankResetButtonCustomId(
  action: RankResetButtonAction,
  leagueId: string,
  playerId: string,
  actorDiscordId: string,
): string {
  return [
    RANK_RESET_CUSTOM_ID_PREFIX,
    rankResetActionCode(action),
    leagueId,
    playerId,
    actorDiscordId,
  ].join(':');
}

/** Bind a confirmation button to its league, player, and initiating actor. */
export function buildRankResetConfirmCustomId(
  leagueId: string,
  playerId: string,
  actorDiscordId: string,
): string {
  return buildRankResetButtonCustomId('confirm', leagueId, playerId, actorDiscordId);
}

/** Bind a cancellation button to its league, player, and initiating actor. */
export function buildRankResetCancelCustomId(
  leagueId: string,
  playerId: string,
  actorDiscordId: string,
): string {
  return buildRankResetButtonCustomId('cancel', leagueId, playerId, actorDiscordId);
}

/** Parse a rank-reset button ID, returning null for malformed or unrelated IDs. */
export function parseRankResetButtonCustomId(
  customId: string,
): ParsedRankResetButtonCustomId | null {
  const [prefix, actionCode, leagueId, playerId, actorDiscordId, extra] = customId.split(':');
  const action = parseRankResetActionCode(actionCode ?? '');
  if (
    prefix !== RANK_RESET_CUSTOM_ID_PREFIX ||
    action === null ||
    !leagueId ||
    !playerId ||
    !actorDiscordId ||
    extra !== undefined
  ) {
    return null;
  }

  return { action, leagueId, playerId, actorDiscordId };
}

/** Re-check every rank-reset eligibility rule and return confirmation data. */
export async function previewRankReset(input: PreviewRankResetInput): Promise<RankResetPreview> {
  const staffOverride = input.targetDiscordId !== input.actorDiscordId;
  if (staffOverride) {
    assertHasMatchModRole({
      actorDiscordId: input.actorDiscordId,
      memberRoleIds: input.memberRoleIds,
      matchModRoleId: input.matchModRoleId,
    });
  }

  const league = await prisma.league.findUnique({
    where: { id: input.leagueId },
  });
  if (league && !isLeagueWritable(league)) {
    throw new RankResetServiceError(LEAGUE_ARCHIVED_MESSAGE);
  }
  if (!league?.rankResetEnabled) {
    throw new RankResetServiceError('Rank reset is disabled for this league.');
  }
  const cooldownDays = assertRankResetCooldownDays(league.rankResetCooldownDays);

  const player = await prisma.player.findUnique({
    where: {
      gameId_discordId: {
        gameId: league.gameId,
        discordId: input.targetDiscordId,
      },
    },
  });
  if (!player) {
    throw new RankResetServiceError(
      staffOverride
        ? 'That Discord user is not linked to a player. They must /link first.'
        : 'Link your Discord with /link before resetting your rank.',
    );
  }

  const activeRosterEntry = await prisma.matchPlayer.findFirst({
    where: {
      playerId: player.id,
      match: {
        leagueId: input.leagueId,
        status: { in: ['PENDING', 'IN_PROGRESS', 'WAITING_FOR_APPROVAL'] },
      },
    },
  });
  if (activeRosterEntry) {
    throw new RankResetServiceError(
      "You can't reset rank while that player is in an active lobby or match.",
    );
  }

  if (!staffOverride) {
    const latestReset = await prisma.playerRankReset.findFirst({
      where: { leagueId: input.leagueId, playerId: player.id },
      orderBy: { createdAt: 'desc' },
    });
    const now = input.now ?? new Date();
    if (latestReset && !isRankResetCooldownElapsed(latestReset.createdAt, cooldownDays, now)) {
      const nextResetUnix = Math.floor(
        nextRankResetAt(latestReset.createdAt, cooldownDays).getTime() / 1000,
      );
      throw new RankResetServiceError(`You can reset again <t:${nextResetUnix}:R>.`);
    }
  }

  return {
    leagueId: input.leagueId,
    playerId: player.id,
    username: player.username,
    targetDiscordId: input.targetDiscordId,
    staffOverride,
    cooldownDays,
  };
}

/** Wipe a player's league-scoped ratings and record the reset atomically. */
export async function applyRankReset(input: ApplyRankResetInput): Promise<RankResetResult> {
  const preview = await previewRankReset(input);
  if (input.expectedPlayerId !== undefined && input.expectedPlayerId !== preview.playerId) {
    throw new RankResetServiceError('That rank reset confirmation is no longer valid.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.playerRating.upsert({
      where: {
        leagueId_playerId: {
          leagueId: preview.leagueId,
          playerId: preview.playerId,
        },
      },
      create: {
        leagueId: preview.leagueId,
        playerId: preview.playerId,
        mu: 25,
        sigma: 8.333,
        idleDecayKiApplied: 0,
        lastDecayAppliedAt: null,
      },
      update: {
        mu: 25,
        sigma: 8.333,
        idleDecayKiApplied: 0,
        lastDecayAppliedAt: null,
      },
    });
    await tx.playerHeroRating.deleteMany({
      where: { leagueId: preview.leagueId, playerId: preview.playerId },
    });
    await tx.playerRankReset.create({
      data: {
        leagueId: preview.leagueId,
        playerId: preview.playerId,
        actorDiscordId: input.actorDiscordId,
        targetDiscordId: preview.targetDiscordId,
        staffOverride: preview.staffOverride,
      },
    });
  });

  return {
    playerId: preview.playerId,
    username: preview.username,
    staffOverride: preview.staffOverride,
  };
}
