import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGameDetail, fetchGamelist, Wc3statsClientError } from './wc3stats-client.js';

describe('wc3stats client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses a wrapped gamelist body array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          body: [
            {
              id: 42,
              name: 'udbr',
              host: 'Host#1',
              map: 'UltimateDragonBallReborn.w3x',
              slotsTaken: 4,
              slotsTotal: 12,
            },
          ],
        }),
      }),
    );

    const games = await fetchGamelist(4000);
    expect(games).toEqual([
      {
        id: 42,
        name: 'udbr',
        host: 'Host#1',
        map: 'UltimateDragonBallReborn.w3x',
        slotsTaken: 4,
        slotsTotal: 12,
        server: undefined,
      },
    ]);
  });

  it('parses a raw gamelist array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { id: 7, name: 'g', host: 'h', map: 'm.w3x', slotsTaken: 1, slotsTotal: 12 },
        ],
      }),
    );

    const games = await fetchGamelist(4000);
    expect(games[0]?.id).toBe(7);
  });

  it('parses a wrapped game detail object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          body: {
            id: 42,
            name: 'udbr',
            host: { name: 'Host', battleTag: 'Host#1' },
            map: {
              path: 'Maps/udbr.w3x',
              normalizedName: 'Ultimate Dragon Ball Reborn',
              sha1: 'abc',
            },
            numPlayers: 2,
            rosterObservedAt: '2026-08-19T18:30:00.000Z',
            slots: [{ status: 'occupied', player: { name: 'Alice' } }],
          },
        }),
      }),
    );

    const detail = await fetchGameDetail(42, 4000);
    expect(detail.id).toBe(42);
    expect(detail.map).toEqual({
      path: 'Maps/udbr.w3x',
      normalizedName: 'Ultimate Dragon Ball Reborn',
      sha1: 'abc',
      name: undefined,
    });
    expect(detail.slots).toHaveLength(1);
    expect(detail.rosterObservedAt?.toISOString()).toBe('2026-08-19T18:30:00.000Z');
  });

  it('throws on non-OK responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      }),
    );

    await expect(fetchGamelist(4000)).rejects.toBeInstanceOf(Wc3statsClientError);
    await expect(fetchGamelist(4000)).rejects.toThrow('wc3stats returned HTTP 500.');
  });

  it('throws when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    await expect(fetchGameDetail(1, 4000)).rejects.toBeInstanceOf(Wc3statsClientError);
    await expect(fetchGameDetail(1, 4000)).rejects.toThrow('Could not reach wc3stats.');
  });
});
