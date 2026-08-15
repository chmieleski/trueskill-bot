import { ActionRowBuilder, ButtonBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { isLeagueWc3statsHostPromptReady } from '../league/league-wc3stats.js';
import { compileWc3statsMapConfig } from './wc3stats-map.js';
import {
  buildHostPromptButtons,
  buildHostPromptCustomId,
  buildHostPromptDismissedContent,
  buildHostPromptMessageContent,
  filterGamelistForHostPrompt,
  parseHostPromptCustomId,
  type HostPromptListGame,
} from './wc3stats-host-prompt.js';

describe('isLeagueWc3statsHostPromptReady', () => {
  it('requires import ready, prompt enabled, and channel', () => {
    expect(
      isLeagueWc3statsHostPromptReady({
        wc3statsEnabled: true,
        wc3statsMapPattern: 'udbr',
        wc3statsHostPromptEnabled: true,
        wc3statsHostPromptChannelId: 'chan-1',
      }),
    ).toBe(true);

    expect(
      isLeagueWc3statsHostPromptReady({
        wc3statsEnabled: false,
        wc3statsMapPattern: 'udbr',
        wc3statsHostPromptEnabled: true,
        wc3statsHostPromptChannelId: 'chan-1',
      }),
    ).toBe(false);

    expect(
      isLeagueWc3statsHostPromptReady({
        wc3statsEnabled: true,
        wc3statsMapPattern: undefined,
        wc3statsHostPromptEnabled: true,
        wc3statsHostPromptChannelId: 'chan-1',
      }),
    ).toBe(false);

    expect(
      isLeagueWc3statsHostPromptReady({
        wc3statsEnabled: true,
        wc3statsMapPattern: 'udbr',
        wc3statsHostPromptEnabled: false,
        wc3statsHostPromptChannelId: 'chan-1',
      }),
    ).toBe(false);

    expect(
      isLeagueWc3statsHostPromptReady({
        wc3statsEnabled: true,
        wc3statsMapPattern: 'udbr',
        wc3statsHostPromptEnabled: true,
        wc3statsHostPromptChannelId: undefined,
      }),
    ).toBe(false);
  });
});

describe('host prompt custom ids', () => {
  it('builds and parses open/dismiss ids', () => {
    const open = buildHostPromptCustomId({
      action: 'open',
      leagueId: 'league_abc',
      wc3statsId: 12345,
      hostDiscordId: '999888777',
    });
    const dismiss = buildHostPromptCustomId({
      action: 'dismiss',
      leagueId: 'league_abc',
      wc3statsId: 12345,
      hostDiscordId: '999888777',
    });

    expect(open).toBe('host_prompt:open:league_abc:12345:999888777');
    expect(dismiss).toBe('host_prompt:dismiss:league_abc:12345:999888777');
    expect(open.length).toBeLessThanOrEqual(100);
    expect(dismiss.length).toBeLessThanOrEqual(100);

    expect(parseHostPromptCustomId(open)).toEqual({
      action: 'open',
      leagueId: 'league_abc',
      wc3statsId: 12345,
      hostDiscordId: '999888777',
    });
    expect(parseHostPromptCustomId(dismiss)).toEqual({
      action: 'dismiss',
      leagueId: 'league_abc',
      wc3statsId: 12345,
      hostDiscordId: '999888777',
    });
  });

  it('rejects malformed custom ids', () => {
    expect(parseHostPromptCustomId('lobby:start')).toBeNull();
    expect(parseHostPromptCustomId('host_prompt:open:league:not-a-number:user')).toBeNull();
    expect(parseHostPromptCustomId('host_prompt:claim:league:1:user')).toBeNull();
    expect(parseHostPromptCustomId('host_prompt:open:league:1')).toBeNull();
  });
});

describe('filterGamelistForHostPrompt', () => {
  const mapConfig = compileWc3statsMapConfig(
    'ultimate.?dragon.?ball.?reborn|udbr',
    [],
  );

  const games: HostPromptListGame[] = [
    {
      id: 1,
      name: 'DBZ Ranked',
      host: 'Goku#1234',
      map: 'UltimateDragonBallReborn_v1.w3x',
    },
    {
      id: 2,
      name: 'DotA',
      host: 'Goku#1234',
      map: 'DotA_v6.w3x',
    },
    {
      id: 3,
      name: 'UDBR 2',
      host: 'Vegeta#99',
      map: 'udbr_test.w3x',
    },
    {
      id: 4,
      name: 'UDBR empty host',
      host: '',
      map: 'UltimateDragonBallReborn.w3x',
    },
  ];

  it('keeps map-matching lobbies whose host nick is in the linked set', () => {
    const linkedByNick = new Map([
      ['goku', 'discord-goku'],
      ['vegeta', 'discord-vegeta'],
    ]);

    const matches = filterGamelistForHostPrompt({
      games,
      mapConfig,
      linkedByNick,
    });

    expect(matches).toEqual([
      {
        wc3statsId: 1,
        lobbyName: 'DBZ Ranked',
        hostNick: 'goku',
        hostDiscordId: 'discord-goku',
      },
      {
        wc3statsId: 3,
        lobbyName: 'UDBR 2',
        hostNick: 'vegeta',
        hostDiscordId: 'discord-vegeta',
      },
    ]);
  });

  it('skips map matches when host nick is not linked', () => {
    const matches = filterGamelistForHostPrompt({
      games,
      mapConfig,
      linkedByNick: new Map([['piccolo', 'discord-piccolo']]),
    });
    expect(matches).toEqual([]);
  });
});

describe('host prompt message builders', () => {
  it('pings the host and includes lobby name + id', () => {
    const content = buildHostPromptMessageContent({
      hostDiscordId: '111',
      lobbyName: 'My Lobby',
      wc3statsId: 42,
    });
    expect(content).toContain('<@111>');
    expect(content).toContain('**My Lobby**');
    expect(content).toContain('`42`');
    expect(content).toContain('Open a Discord match lobby');
  });

  it('builds Open / Dismiss buttons', () => {
    const rows = buildHostPromptButtons({
      leagueId: 'lg',
      wc3statsId: 7,
      hostDiscordId: 'u1',
    });
    expect(rows).toHaveLength(1);
    const ids = (rows[0] as ActionRowBuilder<ButtonBuilder>)
      .toJSON()
      .components.map((button) => button.custom_id);
    expect(ids).toEqual([
      'host_prompt:open:lg:7:u1',
      'host_prompt:dismiss:lg:7:u1',
    ]);
  });

  it('builds a short dismissed state', () => {
    expect(buildHostPromptDismissedContent({ lobbyName: 'X', wc3statsId: 9 })).toBe(
      'Host prompt for **X** (`9`) dismissed.',
    );
  });
});
