import { describe, expect, it } from 'vitest';
import {
  buildLobbyButtons,
  buildMatchCompletedEmbed,
  buildMatchInProgressEmbed,
  buildMatchLobbyEmbed,
  buildMatchReportButtons,
  claimSlotSelectOptions,
  formatSignedDelta,
  formatTeamLines,
  formatTeamLinesFromPreview,
  LOBBY_CUSTOM_IDS,
} from './lobby-preview.js';
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
      { slot: 1, nick: 'goku', globalOrdinal: 1100, heroOrdinal: 2200 },
      { slot: 4, nick: 'gohan', globalOrdinal: 900, heroOrdinal: 950 },
    ]);
    const lines = value.split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^`\s*1\s+goku\s+1100 \/ 2200`$/);
    expect(lines[1]).toMatch(/^`\s*4\s+gohan\s+ 900 \/  950`$/);
    expect(value).not.toContain('—');
  });

  it('appends the quitter marker outside the code span', () => {
    const value = formatTeamLinesFromPreview([
      { slot: 1, nick: 'goku', globalOrdinal: 1100, heroOrdinal: 2200, isQuitter: true },
      { slot: 2, nick: 'vegeta', globalOrdinal: 3300, heroOrdinal: 4400 },
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
        },
        {
          slot: 7,
          nick: 'vegeta',
          globalOrdinal: 900,
          heroOrdinal: 850,
          globalDelta: -100,
          heroDelta: -150,
          isQuitter: true,
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
      },
      {
        slot: 7,
        nick: 'vegeta',
        globalOrdinal: 900,
        heroOrdinal: 850,
        globalDelta: -100,
        heroDelta: -150,
        isQuitter: true,
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
  it('labels roster controls with text so they are readable', () => {
    const rows = buildLobbyButtons({
      playerCount: 2,
      playerClaimEnabled: false,
    });
    const roster = rows.at(-1)?.toJSON().components as Array<{
      custom_id?: string;
      label?: string;
    }>;
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
    const rosterIds = rows.at(-1)?.toJSON().components.map((button) => button.custom_id);

    expect(rosterIds).toContain(LOBBY_CUSTOM_IDS.add);
  });

  it('omits Add when all 12 slots are filled', () => {
    const rows = buildLobbyButtons({
      canStart: true,
      playerCount: 12,
      playerClaimEnabled: false,
    });
    const rosterIds = rows.at(-1)?.toJSON().components.map((button) => button.custom_id);

    expect(rosterIds).not.toContain(LOBBY_CUSTOM_IDS.add);
    expect(rosterIds).toEqual([
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
});

describe('balance hint on embeds', () => {
  it('shows Balance hint on Match Lobby when suggestion present', () => {
    const embed = buildMatchLobbyEmbed('m1', [
      { nick: 'Alice', slot: 1 },
      { nick: 'Bob', slot: 7 },
    ], {
      ratingPreview: {
        players: [
          { slot: 1, nick: 'Alice', globalOrdinal: 1000, heroOrdinal: 1000 },
          { slot: 7, nick: 'Bob', globalOrdinal: 1000, heroOrdinal: 1000 },
        ],
        winChance: { teamAPercent: 70, teamBPercent: 30 },
        balanceSuggestion: {
          kind: 'swap',
          fromSlot: 1,
          toSlot: 7,
          fromNick: 'Alice',
          toNick: 'Bob',
          resultingWinChance: { teamAPercent: 52, teamBPercent: 48 },
        },
      },
    });
    const fields = embed.data.fields ?? [];
    const hint = fields.find((f) => f.name === 'Balance hint');
    expect(hint?.value).toBe('Swap Alice (1) ↔ Bob (7) → ~52% / 48%');
  });

  it('omits Balance hint on Match In Progress even if DTO has suggestion', () => {
    const embed = buildMatchInProgressEmbed('m1', [
      { nick: 'Alice', slot: 1 },
      { nick: 'Bob', slot: 7 },
    ], {
      ratingPreview: {
        players: [
          { slot: 1, nick: 'Alice', globalOrdinal: 1000, heroOrdinal: 1000 },
          { slot: 7, nick: 'Bob', globalOrdinal: 1000, heroOrdinal: 1000 },
        ],
        winChance: { teamAPercent: 70, teamBPercent: 30 },
        balanceSuggestion: {
          kind: 'move',
          fromSlot: 7,
          toSlot: 2,
          fromNick: 'Bob',
          resultingWinChance: { teamAPercent: 51, teamBPercent: 49 },
        },
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
            },
            {
              slot: 7,
              nick: 'vegeta',
              globalOrdinal: 3300,
              heroOrdinal: 4400,
              globalDelta: -50,
              heroDelta: -80,
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
});
