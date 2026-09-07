import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID, WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import { MatchServiceError } from './match-service.js';

const {
  leagueFindUnique,
  matchFindUnique,
  matchUpdate,
  prismaTransaction,
  getGameProfileForLeague,
  persistWos2MatchStats,
  assertWos2ReportExternalIdUnused,
} = vi.hoisted(() => ({
  leagueFindUnique: vi.fn(),
  matchFindUnique: vi.fn(),
  matchUpdate: vi.fn(),
  prismaTransaction: vi.fn(),
  getGameProfileForLeague: vi.fn(),
  persistWos2MatchStats: vi.fn(),
  assertWos2ReportExternalIdUnused: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique: leagueFindUnique },
    match: { findUnique: matchFindUnique, update: matchUpdate },
    $transaction: prismaTransaction,
  },
}));

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../league/league-profile.js', () => ({
  getGameProfileForLeague,
  LeagueNotFoundError: class LeagueNotFoundError extends Error {},
}));

vi.mock('./match-stats-upload.js', () => ({
  persistWos2MatchStats,
  assertWos2ReportExternalIdUnused,
}));

import {
  attachApprovalDiscordMessage,
  ingestWosReportForApproval,
} from './match-waiting-approval.js';

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../games/warcraft3_wos/fixtures',
);
const legacySampleRaw = readFileSync(join(fixturesDir, 'wos2-bot-sample.txt'), 'utf8');

const schema2WithQuitterRaw = `ID|value=36221801-90619783-99790372-91410975|format=WOS2_BOT_V1|scope=MATCH
MATCH|team1_rounds=2|team2_rounds=10|players=3|schema=2|teams_reorganized=0
PLAYER|n=1|pid=0|name=ThunderGear#2310|team=1|win=0|hero_id=1211118146|hero_name=Brandish|left=0|lobby_slot=0|team_slot=1|visual_slot=0
STATS|n=1|pid=0|rounds_played=12|round_wins=2|round_losses=10|kills=0|deaths=10|damage_phys=1581|damage_magic=0|damage_total=1581|heal=80|taken_phys=1342|taken_magic=977|taken_total=2319
ITEMS|n=1|pid=0|slot1=1227894863|slot2=1227894856|slot3=1227895117|slot4=1227894861|slot5=1227895089|slot6=1227895636
PLAYER|n=2|pid=1|name=LavaShark#211786|team=1|win=0|hero_id=1211117634|hero_name=Artoria (Alter)|left=1|lobby_slot=1|team_slot=2|visual_slot=1
STATS|n=2|pid=1|rounds_played=10|round_wins=2|round_losses=8|kills=1|deaths=9|damage_phys=1419|damage_magic=0|damage_total=1419|heal=0|taken_phys=982|taken_magic=763|taken_total=1745
ITEMS|n=2|pid=1|slot1=1227894863|slot2=1227895363|slot3=1227894868|slot4=1227895113|slot5=1227894861|slot6=1227895636
PLAYER|n=3|pid=5|name=MaSeTeR#2245|team=2|win=1|hero_id=1211118145|hero_name=Patriot|left=0|lobby_slot=5|team_slot=1|visual_slot=5
STATS|n=3|pid=5|rounds_played=12|round_wins=10|round_losses=2|kills=2|deaths=3|damage_phys=2324|damage_magic=1740|damage_total=4064|heal=0|taken_phys=3000|taken_magic=0|taken_total=3000
ITEMS|n=3|pid=5|slot1=1227895348|slot2=1227895121|slot3=1227894863|slot4=1227894861|slot5=1227895636|slot6=1227894868
END|id=36221801-90619783-99790372-91410975`;

const baseInput = {
  leagueId: 'league-1',
  guildId: 'guild-1',
  gameId: WARCRAFT3_WOS_GAME_ID,
  matchApprovalChannelId: 'approval-channel-1',
  hostDiscordId: 'bot-client-1',
  reportText: legacySampleRaw,
};

function stubWritableLeague(): void {
  leagueFindUnique.mockResolvedValue({ status: 'ACTIVE' });
  getGameProfileForLeague.mockResolvedValue(getGameProfile(WARCRAFT3_WOS_GAME_ID));
}

/**
 * Run createWaitingApprovalMatch's transaction with players already present in DB.
 * Captures match.create data for assertions.
 */
function stubCreateTransaction(matchId: string): {
  lastCreateData: () => Record<string, unknown> | undefined;
} {
  let lastCreateData: Record<string, unknown> | undefined;

  prismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const playerRows = [
      { id: 'p-chmieleski', username: 'chmieleski' },
      { id: 'p-tiny', username: 'tiny' },
      { id: 'p-thundergear', username: 'thundergear' },
      { id: 'p-lavashark', username: 'lavashark' },
      { id: 'p-maseter', username: 'maseter' },
    ];

    const tx = {
      player: {
        findMany: vi.fn().mockImplementation(async () => playerRows),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      playerRating: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      playerHeroRating: {
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      match: {
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          lastCreateData = data;
          return {
            id: matchId,
            createdAt: new Date('2026-09-07T00:00:00.000Z'),
            ...data,
          };
        }),
      },
    };

    return fn(tx);
  });

  return {
    lastCreateData: () => lastCreateData,
  };
}

function stubMatchPlayersAfterCreate(
  matchId: string,
  players: Array<{ playerId: string; slot: number; username: string; isQuitter?: boolean }>,
): void {
  matchFindUnique.mockResolvedValue({
    id: matchId,
    status: 'WAITING_FOR_APPROVAL',
    players: players.map((entry) => ({
      playerId: entry.playerId,
      slot: entry.slot,
      isQuitter: entry.isQuitter === true,
      player: { username: entry.username },
    })),
  });
}

describe('ingestWosReportForApproval', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    assertWos2ReportExternalIdUnused.mockResolvedValue(undefined);
    persistWos2MatchStats.mockResolvedValue({
      externalId: '34508754-98989487-41346570-71702689',
      summaryLines: [],
      warnings: [],
    });
  });

  it('creates a WAITING_FOR_APPROVAL match and returns externalId + suggested winner', async () => {
    stubWritableLeague();
    const { lastCreateData } = stubCreateTransaction('match-waiting-1');
    stubMatchPlayersAfterCreate('match-waiting-1', [
      { playerId: 'p-chmieleski', slot: 1, username: 'chmieleski' },
      { playerId: 'p-tiny', slot: 6, username: 'tiny' },
    ]);

    const result = await ingestWosReportForApproval(baseInput);

    expect(result).toEqual({
      matchId: 'match-waiting-1',
      status: 'WAITING_FOR_APPROVAL',
      externalId: '34508754-98989487-41346570-71702689',
      suggestedWinner: 2,
      discordMessageUrl: null,
    });

    expect(lastCreateData()).toMatchObject({
      status: 'WAITING_FOR_APPROVAL',
      leagueId: 'league-1',
      hostDiscordId: 'bot-client-1',
      discordChannelId: 'approval-channel-1',
      discordMessageId: null,
      approvalWinnerTeam: 2,
    });

    expect(persistWos2MatchStats).toHaveBeenCalledWith(
      expect.objectContaining({
        matchId: 'match-waiting-1',
        actorDiscordId: 'bot-client-1',
        rawText: legacySampleRaw,
      }),
    );
  });

  it('prefills isQuitter when a report player has left=true', async () => {
    stubWritableLeague();
    const { lastCreateData } = stubCreateTransaction('match-waiting-quit');
    stubMatchPlayersAfterCreate('match-waiting-quit', [
      { playerId: 'p-thundergear', slot: 1, username: 'thundergear' },
      { playerId: 'p-lavashark', slot: 2, username: 'lavashark', isQuitter: true },
      { playerId: 'p-maseter', slot: 6, username: 'maseter' },
    ]);
    persistWos2MatchStats.mockResolvedValue({
      externalId: '36221801-90619783-99790372-91410975',
      summaryLines: [],
      warnings: [],
    });

    await ingestWosReportForApproval({
      ...baseInput,
      reportText: schema2WithQuitterRaw,
    });

    const createData = lastCreateData();
    expect(createData).toBeDefined();
    const players = (createData!.players as { create: Array<{ isQuitter: boolean; slot: number }> })
      .create;
    const quitter = players.find((entry) => entry.slot === 2);
    expect(quitter?.isQuitter).toBe(true);
    expect(
      players.filter((entry) => entry.slot !== 2).every((entry) => entry.isQuitter === false),
    ).toBe(true);
  });

  it('rejects when the game profile is not WOS post-match stats', async () => {
    leagueFindUnique.mockResolvedValue({ status: 'ACTIVE' });
    getGameProfileForLeague.mockResolvedValue(getGameProfile(WARCRAFT3_UDBR_GAME_ID));

    await expect(ingestWosReportForApproval(baseInput)).rejects.toThrow(MatchServiceError);
    await expect(ingestWosReportForApproval(baseInput)).rejects.toThrow(
      /does not accept match stats reports/i,
    );
    expect(prismaTransaction).not.toHaveBeenCalled();
  });

  it('rejects when matchApprovalChannelId is empty', async () => {
    stubWritableLeague();

    await expect(
      ingestWosReportForApproval({ ...baseInput, matchApprovalChannelId: '   ' }),
    ).rejects.toThrow(MatchServiceError);
    await expect(
      ingestWosReportForApproval({ ...baseInput, matchApprovalChannelId: '' }),
    ).rejects.toThrow(/approval channel/i);
    expect(prismaTransaction).not.toHaveBeenCalled();
  });

  it('rejects duplicate externalId before creating a match', async () => {
    stubWritableLeague();
    assertWos2ReportExternalIdUnused.mockRejectedValue(
      new MatchServiceError(
        'This match report (`34508754-98989487-41346570-71702689`) was already uploaded for match `other`.',
      ),
    );

    await expect(ingestWosReportForApproval(baseInput)).rejects.toThrow(MatchServiceError);
    await expect(ingestWosReportForApproval(baseInput)).rejects.toThrow(/already uploaded/);

    expect(assertWos2ReportExternalIdUnused).toHaveBeenCalledWith(
      '34508754-98989487-41346570-71702689',
      '__ingest_precheck__',
    );
    expect(prismaTransaction).not.toHaveBeenCalled();
    expect(persistWos2MatchStats).not.toHaveBeenCalled();
  });
});

describe('attachApprovalDiscordMessage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('updates only discordMessageId on the match', async () => {
    matchUpdate.mockResolvedValue({ id: 'match-1' });

    await attachApprovalDiscordMessage('match-1', 'msg-99');

    expect(matchUpdate).toHaveBeenCalledWith({
      where: { id: 'match-1' },
      data: { discordMessageId: 'msg-99' },
    });
  });
});
