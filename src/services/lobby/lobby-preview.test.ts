import { describe, expect, it } from 'vitest';
import {
  BALANCE_HINT_DISCLAIMER,
  buildLobbyButtons,
  buildMatchCompletedEmbed,
  buildMatchInProgressEmbed,
  buildMatchLobbyEmbed,
  buildMatchReportButtons,
  canStartLobby,
  claimSlotSelectOptions,
  formatSignedDelta,
  formatTeamLines,
  formatTeamLinesFromPreview,
  LOBBY_CUSTOM_IDS,
} from './lobby-preview.js';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID } from '../../domain/games.js';
import { buildCompletedRatingPreview } from '../rating/rating-preview.js';

describe('formatSignedDelta', () => {
  it('formats signed deltas and omits when undefined', () => {
    expect(formatSignedDelta(undefined)).toBe('');
    expect(formatSignedDelta(186)).toBe(' (+186)');
    expect(formatSignedDelta(-50)).toBe(' (-50)');
    expect(formatSignedDelta(0)).toBe(' (0)');
  });
});

describe('formatTeamLines', () => {
  it('prefixes each occupied nick with its slot', () => {
    const value = formatTeamLines([
      { slot: 1, nick: 'goku' },
      { slot: 4, nick: 'gohan' },
    ]);

    expect(value).toBe('**1.** goku\n**4.** gohan');
  });

  it('shows Empty when the team has no players', () => {
    expect(formatTeamLines([])).toBe('_Empty_');
  });
});

describe('formatTeamLinesFromPreview', () => {
  it('prefixes occupied lines with slot numbers', () => {
    const value = formatTeamLinesFromPreview([
      { slot: 1, nick: 'goku', globalOrdinal: 1100, heroOrdinal: 2200, leagueGames: 8 },
      { slot: 4, nick: 'gohan', globalOrdinal: 900, heroOrdinal: 950, leagueGames: 8 },
    ]);
    const lines = value.split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^`\s*1\s+goku\s+1100 \/ 2200`$/);
    expect(lines[1]).toMatch(/^`\s*4\s+gohan\s+ 900 \/  950`$/);
    expect(value).not.toContain('—');
  });

  it('appends the quitter marker outside the code span', () => {
    const value = formatTeamLinesFromPreview([
      { slot: 1, nick: 'goku', globalOrdinal: 1100, heroOrdinal: 2200, isQuitter: true, leagueGames: 8 },
      { slot: 2, nick: 'vegeta', globalOrdinal: 3300, heroOrdinal: 4400, leagueGames: 8 },
    ]);
    const [firstLine, secondLine] = value.split('\n');

    expect(firstLine).toContain('goku');
    expect(firstLine).toContain('🚪');
    expect(firstLine).toMatch(/`\s*1\s+goku\s+1100 \/ 2200`\s+🚪$/);
    expect(secondLine).toContain('vegeta');
    expect(secondLine).not.toContain('🚪');
  });

  it('shows signed ki deltas inline on completed roster lines', () => {
    const value = formatTeamLinesFromPreview(
      [
        {
          slot: 1,
          nick: 'goku',
          globalOrdinal: 1186,
          heroOrdinal: 1200,
          globalDelta: 186,
          heroDelta: 200,
          leagueGames: 8,
        },
        {
          slot: 7,
          nick: 'vegeta',
          globalOrdinal: 900,
          heroOrdinal: 850,
          globalDelta: -100,
          heroDelta: -150,
          isQuitter: true,
          leagueGames: 8,
        },
      ],
    );
    const [firstLine, secondLine] = value.split('\n');

    expect(firstLine).toContain('1186 (+186) / 1200 (+200)');
    expect(firstLine).toMatch(/`\s*1\s+goku/);
    expect(secondLine).toContain(' 900 (-100) /  850 (-150)');
    expect(secondLine).toMatch(/`\s*7\s+vegeta/);
    expect(secondLine).toMatch(/`\s+🚪$/);
  });

  it('omits the hero ki column when showHero is false', () => {
    const value = formatTeamLinesFromPreview([
      { slot: 1, nick: 'alice', globalOrdinal: 1100, heroOrdinal: 1100, showHero: false, leagueGames: 8 },
      { slot: 6, nick: 'bob', globalOrdinal: 900, heroOrdinal: 900, showHero: false, leagueGames: 8 },
    ]);
    const lines = value.split('\n');

    expect(lines[0]).toMatch(/^`\s*1\s+alice\s+1100`$/);
    expect(lines[1]).toMatch(/^`\s*6\s+bob\s+ 900`$/);
    expect(value).not.toContain('/');
  });

  it('prints Calibrating and omits deltas when leagueGames < 5', () => {
    const value = formatTeamLinesFromPreview([
      {
        slot: 1,
        nick: 'goku',
        globalOrdinal: 1186,
        heroOrdinal: 1200,
        globalDelta: 186,
        heroDelta: 200,
        leagueGames: 4,
      },
    ]);
    expect(value).toContain('Calibrating');
    expect(value).not.toContain('1186');
    expect(value).not.toContain('+186');
    expect(value).not.toContain('1200');
  });

  it('shows ki and deltas when the completing match reaches 5', () => {
    const value = formatTeamLinesFromPreview([
      {
        slot: 1,
        nick: 'goku',
        globalOrdinal: 1186,
        heroOrdinal: 1200,
        globalDelta: 186,
        heroDelta: 200,
        leagueGames: 5,
      },
    ]);
    expect(value).toContain('1186 (+186) / 1200 (+200)');
    expect(value).not.toContain('Calibrating');
  });
});

describe('buildCompletedRatingPreview', () => {
  it('attaches after−before ki deltas per player', () => {
    const preview = buildCompletedRatingPreview(
      [
        { playerId: 'p1', slot: 1, team: 1, heroId: 1, nick: 'goku', isQuitter: false },
        { playerId: 'p2', slot: 7, team: 2, heroId: 7, nick: 'vegeta', isQuitter: true },
      ],
      new Map([
        [1, { global: 1000, hero: 1000 }],
        [7, { global: 1000, hero: 1000 }],
      ]),
      new Map([
        [1, { global: 1186, hero: 1200 }],
        [7, { global: 900, hero: 850 }],
      ]),
      new Map([
        ['p1', 5],
        ['p2', 8],
      ]),
    );

    expect(preview.players).toEqual([
      {
        slot: 1,
        nick: 'goku',
        globalOrdinal: 1186,
        heroOrdinal: 1200,
        globalDelta: 186,
        heroDelta: 200,
        isQuitter: false,
        showHero: true,
        leagueGames: 5,
      },
      {
        slot: 7,
        nick: 'vegeta',
        globalOrdinal: 900,
        heroOrdinal: 850,
        globalDelta: -100,
        heroDelta: -150,
        isQuitter: true,
        showHero: true,
        leagueGames: 8,
      },
    ]);
  });
});

describe('buildMatchReportButtons', () => {
  it('renders the match report action row', () => {
    const [row] = buildMatchReportButtons();

    expect(row).toBeDefined();
    expect(row?.toJSON().components.map((button) => button.custom_id)).toEqual([
      'match:report',
      'match:quitters',
      'match:cancel',
    ]);
  });
});

describe('buildLobbyButtons', () => {
  function rowCustomIds(
    row: ReturnType<typeof buildLobbyButtons>[number] | undefined,
  ): Array<string | undefined> {
    return row?.toJSON().components.map((button) => button.custom_id) ?? [];
  }

  function rosterCustomIds(rows: ReturnType<typeof buildLobbyButtons>): Array<string | undefined> {
    const roster = rows.find((row) => rowCustomIds(row).includes(LOBBY_CUSTOM_IDS.editNick));
    return rowCustomIds(roster);
  }

  it('labels roster controls with text so they are readable', () => {
    const rows = buildLobbyButtons({
      playerCount: 2,
      playerClaimEnabled: false,
    });
    const roster = rows
      .find((row) => rowCustomIds(row).includes(LOBBY_CUSTOM_IDS.editNick))
      ?.toJSON().components as Array<{ custom_id?: string; label?: string }>;
    const labels = Object.fromEntries(
      (roster ?? []).map((button) => [button.custom_id, button.label]),
    );

    expect(labels[LOBBY_CUSTOM_IDS.editNick]).toBe('Edit');
    expect(labels[LOBBY_CUSTOM_IDS.move]).toBe('Move');
    expect(labels[LOBBY_CUSTOM_IDS.remove]).toBe('Remove');
    expect(labels[LOBBY_CUSTOM_IDS.add]).toBe('Add');
  });

  it('includes Add when the lobby is not full', () => {
    const rows = buildLobbyButtons({
      canStart: true,
      playerCount: 11,
      playerClaimEnabled: false,
    });

    expect(rosterCustomIds(rows)).toContain(LOBBY_CUSTOM_IDS.add);
  });

  it('omits Add when all 12 slots are filled', () => {
    const rows = buildLobbyButtons({
      canStart: true,
      playerCount: 12,
      playerClaimEnabled: false,
    });

    expect(rosterCustomIds(rows)).not.toContain(LOBBY_CUSTOM_IDS.add);
    expect(rosterCustomIds(rows)).toEqual([
      LOBBY_CUSTOM_IDS.editNick,
      LOBBY_CUSTOM_IDS.move,
      LOBBY_CUSTOM_IDS.remove,
    ]);
  });

  it('adds Claim slot and Leave when player claim is enabled', () => {
    const rows = buildLobbyButtons({ playerCount: 2, playerClaimEnabled: true });
    const ids = rows.flatMap((row) => row.toJSON().components.map((button) => button.custom_id));

    expect(ids).toContain(LOBBY_CUSTOM_IDS.claim);
    expect(ids).toContain(LOBBY_CUSTOM_IDS.leave);
  });

  it('omits Claim and Leave when player claim is disabled', () => {
    const rows = buildLobbyButtons({ playerCount: 2, playerClaimEnabled: false });
    const ids = rows.flatMap((row) => row.toJSON().components.map((button) => button.custom_id));

    expect(ids).not.toContain(LOBBY_CUSTOM_IDS.claim);
    expect(ids).not.toContain(LOBBY_CUSTOM_IDS.leave);
  });

  it('omits Claim when the lobby is full but still shows Leave', () => {
    const rows = buildLobbyButtons({ playerCount: 12, playerClaimEnabled: true });
    const ids = rows.flatMap((row) => row.toJSON().components.map((button) => button.custom_id));

    expect(ids).not.toContain(LOBBY_CUSTOM_IDS.claim);
    expect(ids).toContain(LOBBY_CUSTOM_IDS.leave);
  });

  it('adds Refresh on the start row when a wc3stats game id is set', () => {
    const rows = buildLobbyButtons({
      canStart: true,
      playerCount: 2,
      playerClaimEnabled: false,
      wc3statsGameId: '42',
    });
    const startIds = rows[0]?.toJSON().components.map((button) => button.custom_id);

    expect(startIds).toEqual([LOBBY_CUSTOM_IDS.start, LOBBY_CUSTOM_IDS.refresh]);
  });

  it('adds Refresh on its own row when Start is hidden', () => {
    const rows = buildLobbyButtons({
      playerCount: 0,
      playerClaimEnabled: false,
      wc3statsGameId: '42',
    });
    const ids = rows.flatMap((row) => row.toJSON().components.map((button) => button.custom_id));

    expect(ids).toContain(LOBBY_CUSTOM_IDS.refresh);
    expect(ids).not.toContain(LOBBY_CUSTOM_IDS.start);
  });

  it('adds Refresh when wc3stats is enabled even without a stored game id', () => {
    const rows = buildLobbyButtons({
      playerCount: 0,
      playerClaimEnabled: false,
      wc3statsEnabled: true,
    });
    const ids = rows.flatMap((row) => row.toJSON().components.map((button) => button.custom_id));

    expect(ids).toContain(LOBBY_CUSTOM_IDS.refresh);
  });

  it('omits Add when the profile slot count is filled', () => {
    const aca = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);
    const rows = buildLobbyButtons({
      canStart: true,
      playerCount: 10,
      playerClaimEnabled: false,
      profile: aca,
    });

    expect(rosterCustomIds(rows)).not.toContain(LOBBY_CUSTOM_IDS.add);
  });

  it('puts Cancel on its own last row', () => {
    const rows = buildLobbyButtons({
      canStart: true,
      playerCount: 2,
      playerClaimEnabled: false,
    });

    expect(rowCustomIds(rows.at(-1))).toEqual([LOBBY_CUSTOM_IDS.cancel]);
    expect(rows.at(-1)?.toJSON().components[0]).toMatchObject({
      custom_id: LOBBY_CUSTOM_IDS.cancel,
      label: 'Cancel',
      style: 2,
    });
  });

  it('shows Cancel when Start is hidden', () => {
    const rows = buildLobbyButtons({
      playerCount: 0,
      playerClaimEnabled: false,
    });
    const ids = rows.flatMap((row) => rowCustomIds(row));

    expect(ids).toContain(LOBBY_CUSTOM_IDS.cancel);
    expect(ids).not.toContain(LOBBY_CUSTOM_IDS.start);
    expect(rowCustomIds(rows.at(-1))).toEqual([LOBBY_CUSTOM_IDS.cancel]);
  });

  it('does not put Cancel on the Start / Refresh row', () => {
    const rows = buildLobbyButtons({
      canStart: true,
      playerCount: 2,
      playerClaimEnabled: false,
      wc3statsGameId: '42',
    });

    expect(rowCustomIds(rows[0])).toEqual([LOBBY_CUSTOM_IDS.start, LOBBY_CUSTOM_IDS.refresh]);
    expect(rowCustomIds(rows.at(-1))).toEqual([LOBBY_CUSTOM_IDS.cancel]);
  });

  it('omits Cancel when the card is locked', () => {
    const rows = buildLobbyButtons({ locked: true, canStart: true, playerCount: 2 });

    expect(rows).toEqual([]);
  });
});

describe('claimSlotSelectOptions', () => {
  it('labels empty slots with hero names and skips occupied slots', () => {
    const options = claimSlotSelectOptions(
      [
        { slot: 1, nick: 'goku' },
        { slot: 7, nick: 'vegeta' },
      ],
      (slot) => (slot === 2 ? 'Piccolo' : `Hero ${slot}`),
    );

    expect(options).toHaveLength(10);
    expect(options[0]).toEqual({ label: 'Slot 2 · Piccolo', value: '2' });
    expect(options.map((option) => option.value)).not.toContain('1');
    expect(options.map((option) => option.value)).not.toContain('7');
  });

  it('labels ACA empty slots with team names and stops at slot 10', () => {
    const aca = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);
    const options = claimSlotSelectOptions(
      [
        { slot: 1, nick: 'alice' },
        { slot: 6, nick: 'bob' },
      ],
      () => 'unused',
      aca,
    );

    expect(options).toHaveLength(8);
    expect(options.map((option) => option.value)).not.toContain('11');
    expect(options.map((option) => option.value)).not.toContain('12');
    expect(options[0]).toEqual({ label: 'Slot 2 · Team A', value: '2' });
    expect(options.find((option) => option.value === '6')).toBeUndefined();
    expect(options.find((option) => option.value === '7')).toEqual({
      label: 'Slot 7 · Team B',
      value: '7',
    });
  });
});

describe('balance hint on embeds', () => {
  it('shows Balance hint on Match Lobby when suggestion present', () => {
    const embed = buildMatchLobbyEmbed('m1', [
      { nick: 'Alice', slot: 1 },
      { nick: 'Bob', slot: 7 },
    ], {
      ratingPreview: {
        players: [
          { slot: 1, nick: 'Alice', globalOrdinal: 1000, heroOrdinal: 1000, leagueGames: 8 },
          { slot: 7, nick: 'Bob', globalOrdinal: 1000, heroOrdinal: 1000, leagueGames: 8 },
        ],
        winChance: { teamAPercent: 70, teamBPercent: 30 },
        balanceSuggestions: [
          {
            kind: 'swap',
            fromSlot: 1,
            toSlot: 7,
            fromNick: 'Alice',
            toNick: 'Bob',
            resultingWinChance: { teamAPercent: 52, teamBPercent: 48 },
          },
        ],
      },
    });
    const fields = embed.data.fields ?? [];
    const hint = fields.find((f) => f.name === 'Balance hint');
    expect(hint?.value).toBe(
      `Swap Alice (1) ↔ Bob (7) → ~52% / 48%\n${BALANCE_HINT_DISCLAIMER}`,
    );
  });

  it('lists up to three numbered balance hints', () => {
    const embed = buildMatchLobbyEmbed('m1', [
      { nick: 'Alice', slot: 1 },
      { nick: 'Bob', slot: 7 },
    ], {
      ratingPreview: {
        players: [
          { slot: 1, nick: 'Alice', globalOrdinal: 1000, heroOrdinal: 1000, leagueGames: 8 },
          { slot: 7, nick: 'Bob', globalOrdinal: 1000, heroOrdinal: 1000, leagueGames: 8 },
        ],
        winChance: { teamAPercent: 70, teamBPercent: 30 },
        balanceSuggestions: [
          {
            kind: 'swap',
            fromSlot: 1,
            toSlot: 7,
            fromNick: 'Alice',
            toNick: 'Bob',
            resultingWinChance: { teamAPercent: 52, teamBPercent: 48 },
          },
          {
            kind: 'move',
            fromSlot: 7,
            toSlot: 2,
            fromNick: 'Bob',
            resultingWinChance: { teamAPercent: 51, teamBPercent: 49 },
          },
        ],
      },
    });
    const fields = embed.data.fields ?? [];
    const hint = fields.find((f) => f.name === 'Balance hint');
    expect(hint?.value).toBe(
      `1. Swap Alice (1) ↔ Bob (7) → ~52% / 48%\n2. Move Bob (7) → empty slot 2 → ~51% / 49%\n${BALANCE_HINT_DISCLAIMER}`,
    );
  });

  it('omits Balance hint on Match In Progress even if DTO has suggestion', () => {
    const embed = buildMatchInProgressEmbed('m1', [
      { nick: 'Alice', slot: 1 },
      { nick: 'Bob', slot: 7 },
    ], {
      ratingPreview: {
        players: [
          { slot: 1, nick: 'Alice', globalOrdinal: 1000, heroOrdinal: 1000, leagueGames: 8 },
          { slot: 7, nick: 'Bob', globalOrdinal: 1000, heroOrdinal: 1000, leagueGames: 8 },
        ],
        winChance: { teamAPercent: 70, teamBPercent: 30 },
        balanceSuggestions: [
          {
            kind: 'move',
            fromSlot: 7,
            toSlot: 2,
            fromNick: 'Bob',
            resultingWinChance: { teamAPercent: 51, teamBPercent: 49 },
          },
        ],
      },
    });
    const fields = embed.data.fields ?? [];
    expect(fields.some((f) => f.name === 'Balance hint')).toBe(false);
  });
});

describe('buildMatchLobbyEmbed', () => {
  it('shows slot numbers on occupied players without empty placeholders', () => {
    const embed = buildMatchLobbyEmbed('m1', [
      { nick: 'Alice', slot: 1 },
      { nick: 'Bob', slot: 8 },
    ]);
    const fields = embed.data.fields ?? [];

    expect(fields[0]?.value).toBe('**1.** Alice');
    expect(fields[1]?.value).toBe('**8.** Bob');
    expect(fields[0]?.value).not.toContain('_empty_');
    expect(fields[1]?.value).not.toContain('_empty_');
  });

  it('appends wc3stats source when a game id is linked and the roster is filled', () => {
    const embed = buildMatchLobbyEmbed(
      'm1',
      [
        { nick: 'Alice', slot: 1 },
        { nick: 'Bob', slot: 7 },
      ],
      { wc3statsGameId: '42' },
    );
    expect(embed.data.description).toContain('Source: wc3stats');
  });

  it('explains unpublished wc3stats roster when linked and empty', () => {
    const embed = buildMatchLobbyEmbed('m1', [], { wc3statsGameId: '42' });
    expect(embed.data.description).toContain(
      'wc3stats has not published the player list yet. Use Refresh, a screenshot, or add players.',
    );
  });

  it('explains how to attach wc3stats after create when import is enabled', () => {
    const embed = buildMatchLobbyEmbed('m1', [], { wc3statsLinkAvailable: true });
    expect(embed.data.description).toContain(
      'Use Refresh to attach the live Warcraft lobby. The host Discord must be linked with /link and seated in that lobby.',
    );
  });
});

describe('buildMatchCompletedEmbed', () => {
  it('shows the winner, quitter markers, and ki deltas', () => {
    const embed = buildMatchCompletedEmbed(
      'match-123',
      [
        { slot: 1, nick: 'goku' },
        { slot: 7, nick: 'vegeta' },
      ],
      {
        winningTeam: 1,
        ratingPreview: {
          players: [
            {
              slot: 1,
              nick: 'goku',
              globalOrdinal: 1186,
              heroOrdinal: 1200,
              globalDelta: 186,
              heroDelta: 200,
              isQuitter: true,
              leagueGames: 8,
            },
            {
              slot: 7,
              nick: 'vegeta',
              globalOrdinal: 3300,
              heroOrdinal: 4400,
              globalDelta: -50,
              heroDelta: -80,
              leagueGames: 8,
            },
          ],
        },
      },
    );

    const json = embed.toJSON();

    expect(json.title).toBe('Match Completed');
    expect(json.description).toBe('Z Fighters won the match.');
    expect(json.fields?.[0]?.value).toMatch(/`\s*1\s+goku/);
    expect(json.fields?.[0]?.value).toContain('1186 (+186) / 1200 (+200)');
    expect(json.fields?.[0]?.value).toContain('🚪');
    expect(json.fields?.[1]?.value).toMatch(/`\s*7\s+vegeta/);
    expect(json.fields?.[1]?.value).toContain('3300 (-50) / 4400 (-80)');
    expect(json.fields?.[1]?.value).not.toContain('🚪');
    expect(json.footer?.text).toBe('Per player: slot  nick  global / hero (ki)');
    expect(json.color).toBe(0xf1c40f);
  });

  it('uses Team A / Team B and a global-only footer for ACA', () => {
    const aca = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);
    const embed = buildMatchCompletedEmbed(
      'match-aca',
      [
        { slot: 1, nick: 'alice' },
        { slot: 6, nick: 'bob' },
      ],
      {
        winningTeam: 2,
        profile: aca,
        ratingPreview: {
          players: [
            { slot: 1, nick: 'alice', globalOrdinal: 1100, heroOrdinal: 1100, showHero: false, leagueGames: 8 },
            { slot: 6, nick: 'bob', globalOrdinal: 900, heroOrdinal: 900, showHero: false, leagueGames: 8 },
          ],
        },
      },
    );
    const json = embed.toJSON();

    expect(json.description).toBe('Team B won the match.');
    expect(json.fields?.[0]?.name).toContain('Team A');
    expect(json.fields?.[1]?.name).toContain('Team B');
    expect(json.fields?.[1]?.value).toMatch(/`\s*6\s+bob/);
    expect(json.footer?.text).toBe('Per player: slot  nick  global (ki)');
  });

  it('uses a global-only footer for empty ACA lobbies with an empty preview', () => {
    const aca = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);
    const embed = buildMatchLobbyEmbed('match-aca-empty', [], {
      profile: aca,
      ratingPreview: { players: [] },
    });
    expect(embed.toJSON().footer?.text).toBe('Per player: slot  nick  global (ki)');
  });
});

describe('canStartLobby', () => {
  it('allows UDBR 1+7 and rejects 1+6', () => {
    expect(canStartLobby([{ slot: 1, nick: 'a' }, { slot: 7, nick: 'b' }])).toBe(true);
    expect(canStartLobby([{ slot: 1, nick: 'a' }, { slot: 6, nick: 'b' }])).toBe(false);
  });

  it('allows ACA 1+6 because slot 6 is Team B', () => {
    const aca = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);
    expect(canStartLobby([{ slot: 1, nick: 'a' }, { slot: 6, nick: 'b' }], aca)).toBe(true);
    expect(canStartLobby([{ slot: 1, nick: 'a' }, { slot: 5, nick: 'b' }], aca)).toBe(false);
  });
});
