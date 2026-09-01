import type { League } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  applyGrieferSeasonTaxToSeededGlobals,
  sumGrieferKiTaxByPlayer,
  summarizeGrieferSeasonTax,
  type GrieferSeasonTaxSummary,
} from '../rating/griefer-tax.js';
import {
  gamesByPlayerFromStats,
  loadMatchDisplayStatsByPlayer,
} from '../rating/rank-reset-display.js';

export class LeagueRolloverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeagueRolloverError';
  }
}

export const ROLLOVER_COMPRESSION_MIN = 0;
export const ROLLOVER_COMPRESSION_MAX = 1;
export const ROLLOVER_COMPRESSION_DEFAULT = 0.5;
export const ROLLOVER_DRAFT_TTL_MS = 15 * 60 * 1000;

const DEFAULT_MU = 25;
const DEFAULT_SIGMA = 8.333;
const SIGMA_FLOOR = 6;

const ROLLOVER_CUSTOM_ID_PREFIX = 'lv';
const ROLLOVER_CONFIRM_ACTION = 'c';
const ROLLOVER_CANCEL_ACTION = 'x';

const ACTIVE_MATCH_STATUSES = ['PENDING', 'IN_PROGRESS'] as const;

export type LeagueResetMode = 'hard' | 'soft' | 'continue';

export type SoftResetEntity = { mu: number; sigma: number };
export type SoftResetHeroEntity = SoftResetEntity & {
  heroId: number;
  matchesPlayed: number;
};

export type GlobalRatingSeedRow = {
  playerId: string;
  mu: number;
  sigma: number;
  lastQualifyingActivityAt: Date | null;
  idleDecayKiApplied: number;
  lastDecayAppliedAt: Date | null;
  isNewPlayer: boolean;
};

export type PreviewLeagueRolloverInput = {
  guildId: string;
  sourceLeagueId: string;
  successorName: string;
  resetMode: LeagueResetMode;
  compression?: number;
  actorDiscordId: string;
};

export type LeagueRolloverPreview = {
  draftId: string;
  sourceLeagueId: string;
  sourceLeagueName: string;
  successorName: string;
  resetMode: LeagueResetMode;
  compression: number | null;
  playerCount: number;
  bindingCount: number;
  grieferSeasonTax: GrieferSeasonTaxSummary;
};

export type ApplyLeagueRolloverInput = {
  draftId: string;
  actorDiscordId: string;
  expectedSourceLeagueId?: string;
};

export type LeagueRolloverResult = {
  archivedLeagueId: string;
  archivedLeagueName: string;
  successorLeagueId: string;
  successorLeagueName: string;
  resetMode: LeagueResetMode;
  compression: number | null;
  playersSeeded: number;
  bindingsMoved: number;
  sourceLeaderboardChannelId: string | null;
  sourceLeaderboardMessageId: string | null;
};

export type RolloverButtonAction = 'confirm' | 'cancel';

export type ParsedRolloverButtonCustomId = {
  action: RolloverButtonAction;
  draftId: string;
  actorDiscordId: string;
};

/** Validate soft-reset compression is within [0, 1]. */
export function assertRolloverCompression(value: number): number {
  if (
    !Number.isFinite(value) ||
    value < ROLLOVER_COMPRESSION_MIN ||
    value > ROLLOVER_COMPRESSION_MAX
  ) {
    throw new LeagueRolloverError('Compression must be between 0 and 1.');
  }
  return value;
}

/** Pull μ toward a league or hero mean using retention = 1 - compression. */
export function compressMu(oldMu: number, meanMu: number, compression: number): number {
  const retention = 1 - compression;
  return meanMu + (oldMu - meanMu) * retention;
}

/** Bump σ toward recalibration bounds without exceeding the default. */
export function compressSigma(oldSigma: number): number {
  return Math.min(DEFAULT_SIGMA, Math.max(SIGMA_FLOOR, oldSigma));
}

function meanOf(values: number[], fallback = DEFAULT_MU): number {
  if (values.length === 0) return fallback;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Compress each player's global μ toward the source league mean; copy decay fields. */
export function seedSoftGlobalRatings(
  rows: GlobalRatingSeedRow[],
  compression: number,
): GlobalRatingSeedRow[] {
  const meanMu = meanOf(rows.map((row) => row.mu));
  return rows.map((row) => ({
    playerId: row.playerId,
    mu: compressMu(row.mu, meanMu, compression),
    sigma: compressSigma(row.sigma),
    lastQualifyingActivityAt: row.lastQualifyingActivityAt,
    idleDecayKiApplied: row.idleDecayKiApplied,
    lastDecayAppliedAt: row.lastDecayAppliedAt,
    isNewPlayer: row.isNewPlayer,
  }));
}

/** Compress hero μ per heroId independently and reset matchesPlayed. */
export function seedSoftHeroRatings(
  rows: Array<{
    playerId: string;
    heroId: number;
    mu: number;
    sigma: number;
    matchesPlayed: number;
  }>,
  compression: number,
): Array<{
  playerId: string;
  heroId: number;
  mu: number;
  sigma: number;
  matchesPlayed: number;
}> {
  const byHero = new Map<number, number[]>();
  for (const row of rows) {
    const list = byHero.get(row.heroId) ?? [];
    list.push(row.mu);
    byHero.set(row.heroId, list);
  }

  return rows.map((row) => {
    const meanHeroMu = meanOf(byHero.get(row.heroId) ?? []);
    return {
      playerId: row.playerId,
      heroId: row.heroId,
      mu: compressMu(row.mu, meanHeroMu, compression),
      sigma: compressSigma(row.sigma),
      matchesPlayed: 0,
    };
  });
}

/** Copy global μ, σ, and decay fields onto the successor with no compression or σ bump. */
export function seedContinueGlobalRatings(rows: GlobalRatingSeedRow[]): GlobalRatingSeedRow[] {
  return rows.map((row) => ({
    playerId: row.playerId,
    mu: row.mu,
    sigma: row.sigma,
    lastQualifyingActivityAt: row.lastQualifyingActivityAt,
    idleDecayKiApplied: row.idleDecayKiApplied,
    lastDecayAppliedAt: row.lastDecayAppliedAt,
    isNewPlayer: row.isNewPlayer,
  }));
}

/** Copy hero μ, σ, and matchesPlayed onto the successor unchanged. */
export function seedContinueHeroRatings(
  rows: Array<{
    playerId: string;
    heroId: number;
    mu: number;
    sigma: number;
    matchesPlayed: number;
  }>,
): Array<{
  playerId: string;
  heroId: number;
  mu: number;
  sigma: number;
  matchesPlayed: number;
}> {
  return rows.map((row) => ({
    playerId: row.playerId,
    heroId: row.heroId,
    mu: row.mu,
    sigma: row.sigma,
    matchesPlayed: row.matchesPlayed,
  }));
}

function rolloverActionCode(action: RolloverButtonAction): string {
  return action === 'confirm' ? ROLLOVER_CONFIRM_ACTION : ROLLOVER_CANCEL_ACTION;
}

function parseRolloverActionCode(actionCode: string): RolloverButtonAction | null {
  if (actionCode === ROLLOVER_CONFIRM_ACTION) {
    return 'confirm';
  }
  if (actionCode === ROLLOVER_CANCEL_ACTION) {
    return 'cancel';
  }
  return null;
}

function buildRolloverButtonCustomId(
  action: RolloverButtonAction,
  draftId: string,
  actorDiscordId: string,
): string {
  return [ROLLOVER_CUSTOM_ID_PREFIX, rolloverActionCode(action), draftId, actorDiscordId].join(':');
}

/** Bind a rollover confirmation button to its draft and initiating actor. */
export function buildRolloverConfirmCustomId(draftId: string, actorDiscordId: string): string {
  return buildRolloverButtonCustomId('confirm', draftId, actorDiscordId);
}

/** Bind a rollover cancellation button to its draft and initiating actor. */
export function buildRolloverCancelCustomId(draftId: string, actorDiscordId: string): string {
  return buildRolloverButtonCustomId('cancel', draftId, actorDiscordId);
}

/** Parse a rollover button custom id, returning null for unrelated ids. */
export function parseRolloverButtonCustomId(customId: string): ParsedRolloverButtonCustomId | null {
  const [prefix, actionCode, draftId, actorDiscordId, extra] = customId.split(':');
  const action = parseRolloverActionCode(actionCode ?? '');
  if (
    prefix !== ROLLOVER_CUSTOM_ID_PREFIX ||
    action === null ||
    !draftId ||
    !actorDiscordId ||
    extra !== undefined
  ) {
    return null;
  }

  return { action, draftId, actorDiscordId };
}

type ActiveMatchClient = Pick<typeof prisma.match, 'count' | 'findMany'>;

async function assertNoActiveMatchesWithClient(
  client: { match: ActiveMatchClient },
  leagueId: string,
): Promise<void> {
  const [activeCount, sampleMatches] = await Promise.all([
    client.match.count({
      where: {
        leagueId,
        status: { in: [...ACTIVE_MATCH_STATUSES] },
      },
    }),
    client.match.findMany({
      where: {
        leagueId,
        status: { in: [...ACTIVE_MATCH_STATUSES] },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 5,
    }),
  ]);

  if (activeCount === 0) {
    return;
  }

  const idList = sampleMatches.map((match) => `\`${match.id}\``).join(', ');
  throw new LeagueRolloverError(
    `Finish or cancel all active lobbies and matches first (${activeCount} active: ${idList}).`,
  );
}

async function assertNoActiveMatches(leagueId: string): Promise<void> {
  return assertNoActiveMatchesWithClient(prisma, leagueId);
}

async function loadPendingGrieferTaxForLeague(leagueId: string) {
  const rows = await prisma.matchPlayer.findMany({
    where: {
      isGriefer: true,
      isQuitter: false,
      grieferKiAccrued: { not: null },
      match: { leagueId },
    },
    select: { playerId: true, grieferKiAccrued: true },
  });
  return sumGrieferKiTaxByPlayer(rows);
}

async function clearConsumedGrieferKiAccruals(
  leagueId: string,
  db: Pick<typeof prisma, 'matchPlayer'> = prisma,
): Promise<void> {
  await db.matchPlayer.updateMany({
    where: {
      grieferKiAccrued: { not: null },
      match: { leagueId },
    },
    data: { grieferKiAccrued: null },
  });
}

type GlobalRatingRow = { playerId: string; mu: number; sigma: number };

/** Apply deferred tax to ending-season global μ (archived board / rewards). */
function applyGrieferTaxToEndingSeasonGlobals(
  rows: GlobalRatingRow[],
  taxByPlayer: ReturnType<typeof sumGrieferKiTaxByPlayer>,
  gamesByPlayer: Map<string, number>,
): GlobalRatingRow[] {
  if (taxByPlayer.size === 0) {
    return rows;
  }
  return applyGrieferSeasonTaxToSeededGlobals(rows, taxByPlayer, gamesByPlayer);
}

async function persistEndingSeasonGrieferTax(
  leagueId: string,
  rows: GlobalRatingRow[],
  taxByPlayer: ReturnType<typeof sumGrieferKiTaxByPlayer>,
  gamesByPlayer: Map<string, number>,
  db: Pick<typeof prisma, 'playerRating' | 'matchPlayer'>,
): Promise<GlobalRatingRow[]> {
  const taxed = applyGrieferTaxToEndingSeasonGlobals(rows, taxByPlayer, gamesByPlayer);
  if (taxByPlayer.size === 0) {
    return taxed;
  }

  for (const row of taxed) {
    const before = rows.find((entry) => entry.playerId === row.playerId);
    if (!before || before.mu === row.mu) {
      continue;
    }
    await db.playerRating.update({
      where: { leagueId_playerId: { leagueId, playerId: row.playerId } },
      data: { mu: row.mu },
    });
  }

  await clearConsumedGrieferKiAccruals(leagueId, db);
  return taxed;
}

function globalSeedRowsWithTaxedMu(
  globalRatings: Array<{
    playerId: string;
    mu: number;
    sigma: number;
    lastQualifyingActivityAt: Date | null;
    idleDecayKiApplied: number;
    lastDecayAppliedAt: Date | null;
    isNewPlayer: boolean;
  }>,
  taxedSourceGlobals: GlobalRatingRow[],
): GlobalRatingSeedRow[] {
  const taxedMu = new Map(taxedSourceGlobals.map((row) => [row.playerId, row.mu]));
  return globalRatings.map((row) => ({
    playerId: row.playerId,
    mu: taxedMu.get(row.playerId) ?? row.mu,
    sigma: row.sigma,
    lastQualifyingActivityAt: row.lastQualifyingActivityAt,
    idleDecayKiApplied: row.idleDecayKiApplied,
    lastDecayAppliedAt: row.lastDecayAppliedAt,
    isNewPlayer: row.isNewPlayer,
  }));
}

async function countRolloverPlayers(leagueId: string): Promise<number> {
  const [globalRatings, heroRatings] = await Promise.all([
    prisma.playerRating.findMany({
      where: { leagueId },
      select: { playerId: true },
    }),
    prisma.playerHeroRating.findMany({
      where: { leagueId },
      select: { playerId: true },
    }),
  ]);

  const playerIds = new Set<string>();
  for (const row of globalRatings) {
    playerIds.add(row.playerId);
  }
  for (const row of heroRatings) {
    playerIds.add(row.playerId);
  }
  return playerIds.size;
}

function successorLeagueCreateData(
  source: League,
  successorName: string,
  resetMode: LeagueResetMode,
) {
  return {
    guildId: source.guildId,
    gameId: source.gameId,
    name: successorName,
    predecessorLeagueId: source.id,
    wc3statsEnabled: source.wc3statsEnabled,
    wc3statsMapPattern: source.wc3statsMapPattern,
    wc3statsMapSha1: source.wc3statsMapSha1,
    leaderboardChannelId: source.leaderboardChannelId,
    leaderboardSize: source.leaderboardSize,
    lobbyPlayerClaimEnabled: source.lobbyPlayerClaimEnabled,
    lobbyChannelEnabled: source.lobbyChannelEnabled,
    lobbyChannelId: source.lobbyChannelId,
    wc3statsHostPromptEnabled: source.wc3statsHostPromptEnabled,
    wc3statsHostPromptChannelId: source.wc3statsHostPromptChannelId,
    wc3statsHostPromptPingsEnabled: source.wc3statsHostPromptPingsEnabled,
    rankResetEnabled: source.rankResetEnabled,
    rankResetCooldownDays: source.rankResetCooldownDays,
    showSideWinLoss: source.showSideWinLoss,
    seasonEndsAt: source.seasonEndsAt,
    crunchStartedAt: source.crunchStartedAt,
    decayEnabled: resetMode === 'continue' ? false : (source.decayEnabled ?? true),
    balanceStaticSigmaEnabled: source.balanceStaticSigmaEnabled,
    decayMidGraceDays: source.decayMidGraceDays,
    decayMidTier1Ki: source.decayMidTier1Ki,
    decayMidTier2Ki: source.decayMidTier2Ki,
    decayMidTier1SpanDays: source.decayMidTier1SpanDays,
    decayMidStreakCapKi: source.decayMidStreakCapKi,
    decayCrunchGraceDays: source.decayCrunchGraceDays,
    decayCrunchTier1Ki: source.decayCrunchTier1Ki,
    decayCrunchTier2Ki: source.decayCrunchTier2Ki,
    decayCrunchTier1SpanDays: source.decayCrunchTier1SpanDays,
    decayCrunchWindowDays: source.decayCrunchWindowDays,
    decayPrizeLockEnabled: source.decayPrizeLockEnabled,
    decayPrizeLockMinGames: source.decayPrizeLockMinGames,
  };
}

function parseResetMode(value: string): LeagueResetMode {
  if (value === 'hard' || value === 'soft' || value === 'continue') {
    return value;
  }
  throw new LeagueRolloverError('That rollover confirmation is no longer valid.');
}

async function loadActiveSourceLeague(leagueId: string, guildId?: string): Promise<League> {
  const league = await prisma.league.findUnique({ where: { id: leagueId } });
  if (!league) {
    throw new LeagueRolloverError('That league was not found.');
  }
  if (guildId !== undefined && league.guildId !== guildId) {
    throw new LeagueRolloverError('That league is not in this server.');
  }
  if (league.status === 'ARCHIVED') {
    throw new LeagueRolloverError('That league is archived and cannot be rolled over.');
  }
  return league;
}

/** Validate rollover eligibility and store a short-lived confirmation draft. */
export async function previewLeagueRollover(
  input: PreviewLeagueRolloverInput,
): Promise<LeagueRolloverPreview> {
  const successorName = input.successorName.trim();
  if (!successorName) {
    throw new LeagueRolloverError('Successor league name cannot be empty.');
  }

  const source = await loadActiveSourceLeague(input.sourceLeagueId, input.guildId);

  if (input.resetMode !== 'soft' && input.compression !== undefined) {
    throw new LeagueRolloverError('Compression is only used with reset:soft.');
  }

  const compression =
    input.resetMode === 'soft'
      ? assertRolloverCompression(input.compression ?? ROLLOVER_COMPRESSION_DEFAULT)
      : null;

  await assertNoActiveMatches(source.id);

  const [playerCount, bindingCount, grieferTaxByPlayer] = await Promise.all([
    countRolloverPlayers(source.id),
    prisma.leagueChannelBinding.count({ where: { leagueId: source.id } }),
    loadPendingGrieferTaxForLeague(source.id),
  ]);
  const grieferSeasonTax = summarizeGrieferSeasonTax(grieferTaxByPlayer);

  const expiredBefore = new Date(Date.now() - ROLLOVER_DRAFT_TTL_MS);
  await prisma.leagueRolloverDraft.deleteMany({
    where: {
      sourceLeagueId: source.id,
      actorDiscordId: input.actorDiscordId,
      createdAt: { lt: expiredBefore },
    },
  });

  const draft = await prisma.leagueRolloverDraft.create({
    data: {
      sourceLeagueId: source.id,
      successorName,
      resetMode: input.resetMode,
      compression,
      actorDiscordId: input.actorDiscordId,
    },
  });

  return {
    draftId: draft.id,
    sourceLeagueId: source.id,
    sourceLeagueName: source.name,
    successorName,
    resetMode: input.resetMode,
    compression,
    playerCount,
    bindingCount,
    grieferSeasonTax,
  };
}

/** Apply a confirmed rollover draft inside a single transaction. */
export async function applyLeagueRollover(
  input: ApplyLeagueRolloverInput,
): Promise<LeagueRolloverResult> {
  const draft = await prisma.leagueRolloverDraft.findUnique({
    where: { id: input.draftId },
    include: { sourceLeague: true },
  });

  if (!draft) {
    throw new LeagueRolloverError('That rollover confirmation is no longer valid.');
  }

  if (draft.actorDiscordId !== input.actorDiscordId) {
    throw new LeagueRolloverError(
      'Only the person who ran /league rollover can use these buttons.',
    );
  }

  if (
    input.expectedSourceLeagueId !== undefined &&
    input.expectedSourceLeagueId !== draft.sourceLeagueId
  ) {
    throw new LeagueRolloverError('That rollover confirmation is no longer valid.');
  }

  const source = draft.sourceLeague;
  if (source.status === 'ARCHIVED') {
    throw new LeagueRolloverError('That league is archived and cannot be rolled over.');
  }

  const sourceLeaderboardChannelId = source.leaderboardChannelId;
  const sourceLeaderboardMessageId = source.leaderboardMessageId;

  const resetMode = parseResetMode(draft.resetMode);
  const compression = draft.compression;

  const [globalRatings, heroRatings, slotMaps] = await Promise.all([
    prisma.playerRating.findMany({ where: { leagueId: source.id } }),
    prisma.playerHeroRating.findMany({ where: { leagueId: source.id } }),
    prisma.leagueWc3statsSlotMap.findMany({ where: { leagueId: source.id } }),
  ]);

  const playerIds = new Set<string>();
  for (const row of globalRatings) {
    playerIds.add(row.playerId);
  }
  for (const row of heroRatings) {
    playerIds.add(row.playerId);
  }

  const [grieferTaxByPlayer, displayStats] = await Promise.all([
    loadPendingGrieferTaxForLeague(source.id),
    loadMatchDisplayStatsByPlayer(source.id),
  ]);
  const gamesByPlayer = gamesByPlayerFromStats(displayStats);

  const sourceGlobalRows: GlobalRatingRow[] = globalRatings.map((row) => ({
    playerId: row.playerId,
    mu: row.mu,
    sigma: row.sigma,
  }));

  const result = await prisma.$transaction(async (tx) => {
    await assertNoActiveMatchesWithClient(tx, source.id);

    const taxedSourceGlobals = await persistEndingSeasonGrieferTax(
      source.id,
      sourceGlobalRows,
      grieferTaxByPlayer,
      gamesByPlayer,
      tx,
    );

    const successor = await tx.league.create({
      data: successorLeagueCreateData(source, draft.successorName, resetMode),
    });

    if (resetMode === 'hard') {
      if (playerIds.size > 0) {
        await tx.playerRating.createMany({
          data: [...playerIds].map((playerId) => ({
            leagueId: successor.id,
            playerId,
            mu: DEFAULT_MU,
            sigma: DEFAULT_SIGMA,
            idleDecayKiApplied: 0,
            lastQualifyingActivityAt: null,
            lastDecayAppliedAt: null,
          })),
        });
      }
    } else if (resetMode === 'continue') {
      const seededGlobals = seedContinueGlobalRatings(
        globalSeedRowsWithTaxedMu(globalRatings, taxedSourceGlobals),
      );

      if (seededGlobals.length > 0) {
        await tx.playerRating.createMany({
          data: seededGlobals.map((row) => ({
            leagueId: successor.id,
            playerId: row.playerId,
            mu: row.mu,
            sigma: row.sigma,
            lastQualifyingActivityAt: row.lastQualifyingActivityAt,
            idleDecayKiApplied: row.idleDecayKiApplied,
            lastDecayAppliedAt: row.lastDecayAppliedAt,
            isNewPlayer: row.isNewPlayer,
          })),
        });
      }

      const seededHeroes = seedContinueHeroRatings(
        heroRatings.map((row) => ({
          playerId: row.playerId,
          heroId: row.heroId,
          mu: row.mu,
          sigma: row.sigma,
          matchesPlayed: row.matchesPlayed,
        })),
      );

      if (seededHeroes.length > 0) {
        await tx.playerHeroRating.createMany({
          data: seededHeroes.map((row) => ({
            leagueId: successor.id,
            playerId: row.playerId,
            heroId: row.heroId,
            mu: row.mu,
            sigma: row.sigma,
            matchesPlayed: row.matchesPlayed,
          })),
        });
      }
    } else {
      const seededGlobalsRaw = seedSoftGlobalRatings(
        globalSeedRowsWithTaxedMu(globalRatings, taxedSourceGlobals),
        compression ?? ROLLOVER_COMPRESSION_DEFAULT,
      );

      const globalPlayerIds = new Set(taxedSourceGlobals.map((row) => row.playerId));
      for (const playerId of playerIds) {
        if (!globalPlayerIds.has(playerId)) {
          seededGlobalsRaw.push({
            playerId,
            mu: DEFAULT_MU,
            sigma: DEFAULT_SIGMA,
            lastQualifyingActivityAt: null,
            idleDecayKiApplied: 0,
            lastDecayAppliedAt: null,
            isNewPlayer: false,
          });
        }
      }

      if (seededGlobalsRaw.length > 0) {
        await tx.playerRating.createMany({
          data: seededGlobalsRaw.map((row) => ({
            leagueId: successor.id,
            playerId: row.playerId,
            mu: row.mu,
            sigma: row.sigma,
            lastQualifyingActivityAt: row.lastQualifyingActivityAt,
            idleDecayKiApplied: row.idleDecayKiApplied,
            lastDecayAppliedAt: row.lastDecayAppliedAt,
            isNewPlayer: row.isNewPlayer,
          })),
        });
      }

      const seededHeroes = seedSoftHeroRatings(
        heroRatings.map((row) => ({
          playerId: row.playerId,
          heroId: row.heroId,
          mu: row.mu,
          sigma: row.sigma,
          matchesPlayed: row.matchesPlayed,
        })),
        compression ?? ROLLOVER_COMPRESSION_DEFAULT,
      );

      if (seededHeroes.length > 0) {
        await tx.playerHeroRating.createMany({
          data: seededHeroes.map((row) => ({
            leagueId: successor.id,
            playerId: row.playerId,
            heroId: row.heroId,
            mu: row.mu,
            sigma: row.sigma,
            matchesPlayed: row.matchesPlayed,
          })),
        });
      }
    }

    if (slotMaps.length > 0) {
      await tx.leagueWc3statsSlotMap.createMany({
        data: slotMaps.map((row) => ({
          leagueId: successor.id,
          wc3statsSlot: row.wc3statsSlot,
          heroId: row.heroId,
        })),
      });
    }

    const bindingsMoved = await tx.leagueChannelBinding.updateMany({
      where: { leagueId: source.id },
      data: { leagueId: successor.id },
    });

    await tx.league.update({
      where: { id: source.id },
      data: {
        status: 'ARCHIVED',
        archivedAt: new Date(),
        leaderboardMessageId: null,
      },
    });

    await tx.leagueRolloverDraft.delete({ where: { id: draft.id } });

    return {
      archivedLeagueId: source.id,
      archivedLeagueName: source.name,
      successorLeagueId: successor.id,
      successorLeagueName: successor.name,
      resetMode,
      compression,
      playersSeeded: playerIds.size,
      bindingsMoved: bindingsMoved.count,
      sourceLeaderboardChannelId,
      sourceLeaderboardMessageId,
    };
  });

  return result;
}

/** Delete a rollover draft when the initiating actor cancels. */
export async function cancelLeagueRolloverDraft(
  draftId: string,
  actorDiscordId: string,
): Promise<void> {
  const draft = await prisma.leagueRolloverDraft.findUnique({
    where: { id: draftId },
  });
  if (!draft) {
    return;
  }
  if (draft.actorDiscordId !== actorDiscordId) {
    throw new LeagueRolloverError(
      'Only the person who ran /league rollover can use these buttons.',
    );
  }
  await prisma.leagueRolloverDraft.delete({ where: { id: draftId } });
}
