import type { LobbyDraft } from '@dbz/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';

const m = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  replaceMatchRoster: vi.fn(),
  syncLobby: vi.fn(),
  schedule: vi.fn(),
  clear: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  getMatch: vi.fn(),
  findActive: vi.fn(),
}));
vi.mock('./draft-state.js', async (orig) => ({
  ...(await orig<typeof import('./draft-state.js')>()),
  loadLobbyDraftById: m.load,
  findActiveLobbyDraftForMatch: m.findActive,
  saveLobbyDraftState: m.save,
}));
vi.mock('./draft-timer.js', () => ({
  scheduleLobbyDraftTimeout: m.schedule,
  clearLobbyDraftTimer: m.clear,
}));
vi.mock('../league/league-profile.js', () => ({
  getGameProfileForLeague: async () => getGameProfile(WARCRAFT3_UDBR_GAME_ID),
}));
vi.mock('../match/match-service.js', async (orig) => ({
  ...(await orig<typeof import('../match/match-service.js')>()),
  replaceMatchRoster: m.replaceMatchRoster,
  getMatchByDiscordMessageId: m.getMatch,
}));
vi.mock('../league/league-wc3stats.js', () => ({
  resolveLeagueConfig: async () => ({ lobbyCaptainDraftEnabled: true }),
}));
vi.mock('../lobby/discord-sync.js', () => ({ syncLobbyDiscordMessage: m.syncLobby }));
vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    hero: { findMany: vi.fn().mockResolvedValue([]) },
    playerRating: { findMany: vi.fn().mockResolvedValue([]) },
    lobbyDraft: { updateMany: m.updateMany, update: m.update },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        $executeRaw: async () => 1,
        lobbyDraft: {
          findFirst: async () => null,
          create: async () => row(initialLobbyDraftState([], null)),
        },
      }),
  },
}));

import {
  cancelLobbyDraft,
  getHeroMenuForActor,
  getVoteMenuForActor,
  lockInHeroes,
  finalizeLobbyDraft,
  startLobbyDraft,
  syncLobbyDraftLiveMessage,
  voteCaptains,
} from './draft-actions.js';
import { prisma } from '../../lib/prisma.js';
import { LobbyDraftConflictError } from './draft-types.js';
import { initialLobbyDraftState } from './draft-types.js';
import { person, pickingState } from './test-fixtures.js';

const client = { channels: { fetch: vi.fn().mockResolvedValue(null) } } as never;
function row(state: unknown): LobbyDraft {
  return {
    id: 'd1',
    status: 'ACTIVE',
    leagueId: 'L',
    matchId: 'M',
    threadId: 'T',
    liveMessageId: null,
    hostDiscordId: 'h',
    state,
    updatedAt: new Date(),
  } as unknown as LobbyDraft;
}

describe('lobby draft actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.syncLobby.mockResolvedValue(undefined);
  });

  it('retries on save conflict', async () => {
    const draft = row(
      initialLobbyDraftState(
        ['A', 'B', 'C', 'D'].map((n) => person(n)),
        null,
      ),
    );
    m.load.mockResolvedValue(draft);
    m.save.mockRejectedValueOnce(new LobbyDraftConflictError()).mockResolvedValueOnce(draft);
    await voteCaptains({ client, draftId: 'd1', actorDiscordId: 'id-A', keys: ['a'] });
    expect(m.save).toHaveBeenCalledTimes(2);
    expect(m.load).toHaveBeenCalledTimes(3); // 2 attempts reload + 1 live-message sync
  });

  it('finalizes into the lobby when the last linked player locks in', async () => {
    const base = pickingState(['A', 'B', 'C', 'D']);
    const state = {
      ...base,
      phase: 'HERO' as const,
      pool: [],
      teams: [
        { captainKey: 'a', roster: ['a', 'c'], side: 1 as const },
        { captainKey: 'b', roster: ['b', 'd'], side: 2 as const },
      ] as typeof base.teams,
      heroLockedIn: ['a', 'b', 'c'],
    };
    const draft = row(state);
    m.load.mockResolvedValue(draft);
    m.save.mockResolvedValue(draft);
    m.replaceMatchRoster.mockResolvedValue({ id: 'M' });
    await lockInHeroes({ client, draftId: 'd1', actorDiscordId: 'id-D' });
    const [matchId, players, options] = m.replaceMatchRoster.mock.calls[0]!;
    expect(matchId).toBe('M');
    expect(options).toEqual({ markLobbyRosterAuthority: true, completeLobbyDraftId: 'd1' });
    expect(players).toHaveLength(4);
    for (const p of players as Array<{ slot: number; nick: string }>) {
      expect(['A', 'C'].includes(p.nick) ? p.slot <= 6 : p.slot >= 7).toBe(true);
    }
    expect(m.syncLobby).toHaveBeenCalled();
  });

  it('cancelling a non-ACTIVE draft posts nothing', async () => {
    m.updateMany.mockResolvedValue({ count: 0 });
    const send = vi.fn();
    const fetch = vi.fn().mockResolvedValue({ isThread: () => true, send });
    await cancelLobbyDraft({ channels: { fetch } } as never, 'd1', 'x');
    expect(send).not.toHaveBeenCalled();
    expect(m.clear).not.toHaveBeenCalled();
  });

  const heroState = () => {
    const base = pickingState(['A', 'B', 'C', 'D']);
    return {
      ...base,
      phase: 'HERO' as const,
      pool: [],
      teams: [
        { captainKey: 'a', roster: ['a', 'c'], side: 1 as const },
        { captainKey: 'b', roster: ['b', 'd'], side: 2 as const },
      ] as typeof base.teams,
      heroLockedIn: ['a', 'b', 'c'],
    };
  };

  it('still finalizes when the thread notification fails', async () => {
    const draft = row(heroState());
    m.load.mockResolvedValue(draft);
    m.save.mockResolvedValue(draft);
    m.replaceMatchRoster.mockResolvedValue({ id: 'M' });
    const fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send: vi.fn().mockRejectedValue(new Error('discord down')),
      messages: { fetch: vi.fn().mockResolvedValue(null) },
    });
    await lockInHeroes({
      client: { channels: { fetch } } as never,
      draftId: 'd1',
      actorDiscordId: 'id-D',
    });
    expect(m.replaceMatchRoster).toHaveBeenCalled();
  });

  it('start cancels the draft when the live message send fails', async () => {
    m.getMatch.mockResolvedValue({
      id: 'MATCH1',
      status: 'PENDING',
      discordMessageId: 'msg',
      discordChannelId: 'ch',
      hostDiscordId: 'h',
      leagueId: 'L',
      players: ['A', 'B', 'C', 'D'].map((n) => ({
        player: { username: n.toLowerCase(), discordId: `id-${n}` },
      })),
    });
    m.findActive.mockResolvedValue(null);
    m.updateMany.mockResolvedValue({ count: 1 });
    m.load.mockResolvedValue(row(initialLobbyDraftState([], null)));
    const thread = {
      id: 'T',
      guildId: 'G',
      send: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const channel = {
      type: 0,
      id: 'ch',
      isThread: () => false,
      threads: { create: vi.fn().mockResolvedValue(thread) },
    };
    const c = { channels: { fetch: vi.fn().mockResolvedValue(channel) } } as never;
    await expect(
      startLobbyDraft({ client: c, messageId: 'msg', actorDiscordId: 'h', memberRoleIds: [] }),
    ).rejects.toThrow('boom');
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', status: 'ACTIVE' },
      data: { status: 'CANCELLED' },
    });
  });

  it('sync re-posts the live message on Unknown Message and stores the id', async () => {
    m.load.mockResolvedValue({ ...row(heroState()), liveMessageId: 'old' });
    const send = vi.fn().mockResolvedValue({ id: 'new' });
    const fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send,
      messages: { fetch: vi.fn().mockRejectedValue({ code: 10008 }) },
    });
    await syncLobbyDraftLiveMessage({ channels: { fetch } } as never, 'd1');
    expect(send).toHaveBeenCalled();
    expect(m.update).toHaveBeenCalledWith({ where: { id: 'd1' }, data: { liveMessageId: 'new' } });
  });

  it('finalizeLobbyDraft recovers an ACTIVE draft with heroResult set', async () => {
    const heroResult = Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((k, i) => [k, { heroId: i + 1, how: 'pref' }]),
    );
    m.load.mockResolvedValue(row({ ...heroState(), heroResult }));
    m.replaceMatchRoster.mockResolvedValue({ id: 'M' });
    await finalizeLobbyDraft(client, 'd1');
    expect(m.replaceMatchRoster).toHaveBeenCalled();
  });

  it('finalizeLobbyDraft ignores drafts without heroResult', async () => {
    m.load.mockResolvedValue(row(heroState()));
    await finalizeLobbyDraft(client, 'd1');
    expect(m.replaceMatchRoster).not.toHaveBeenCalled();
  });

  it('thread log shows hero names for contested rolls', async () => {
    const state = { ...heroState(), heroPrefs: { a: [1], c: [1] } };
    const draft = row(state);
    m.load.mockResolvedValue(draft);
    m.save.mockResolvedValue(draft);
    m.replaceMatchRoster.mockResolvedValue({ id: 'M' });
    vi.mocked(prisma.hero.findMany).mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `Hero${i + 1}` })) as never,
    );
    const send = vi.fn().mockResolvedValue({});
    const fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send,
      messages: { fetch: vi.fn().mockResolvedValue(null) },
    });
    await lockInHeroes({
      client: { channels: { fetch } } as never,
      draftId: 'd1',
      actorDiscordId: 'id-D',
    });
    const posted = send.mock.calls.map((c) => String(c[0]?.content ?? c[0])).join('\n');
    expect(posted).toMatch(/won the roll for Hero\d+/);
    expect(posted).not.toContain('hero #');
  });

  it('deletes older bot notices beyond the line budget, keeping the live message', async () => {
    const state = { ...heroState(), heroPrefs: { a: [1], c: [1] } };
    const draft = { ...row(state), liveMessageId: 'live' };
    m.load.mockResolvedValue(draft);
    m.save.mockResolvedValue(draft);
    m.replaceMatchRoster.mockResolvedValue({ id: 'M' });
    vi.mocked(prisma.hero.findMany).mockResolvedValue([] as never);
    const msg = (id: string, at: number, content: string, author = 'bot') => ({
      id,
      createdTimestamp: at,
      content,
      system: false,
      author: { id: author },
      delete: vi.fn().mockResolvedValue(undefined),
    });
    const msgs = [
      msg('live', 0, 'a\nb\nc\nd\ne\nf\ng'),
      msg('old', 1, 'x\ny'),
      msg('user', 2, 'hi', 'human'),
      msg('mid', 3, 'x\ny\nz'),
      msg('new', 4, 'x\ny\nz'),
    ];
    const fetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      send: vi.fn().mockResolvedValue({}),
      messages: {
        fetch: vi.fn().mockResolvedValue(new Map(msgs.map((x) => [x.id, x]))),
      },
    });
    await lockInHeroes({
      client: { channels: { fetch }, user: { id: 'bot' } } as never,
      draftId: 'd1',
      actorDiscordId: 'id-D',
    });
    const deleted = msgs.filter((x) => x.delete.mock.calls.length).map((x) => x.id);
    expect(deleted).toEqual(['old']);
  });

  it('menus refuse non-ACTIVE drafts', async () => {
    m.load.mockResolvedValue({ ...row(heroState()), status: 'CANCELLED' });
    await expect(getVoteMenuForActor('d1', 'id-A')).rejects.toThrow('no longer active');
    await expect(getHeroMenuForActor('d1', 'id-A')).rejects.toThrow('no longer active');
  });
});
