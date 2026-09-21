import { beforeEach, describe, expect, it, vi } from 'vitest';

const { leagueBindingFindUnique, eventBindingUpsert, eventBindingFindUnique, leagueBindingUpsert } =
  vi.hoisted(() => ({
    leagueBindingFindUnique: vi.fn(),
    eventBindingUpsert: vi.fn(),
    eventBindingFindUnique: vi.fn(),
    leagueBindingUpsert: vi.fn(),
  }));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    leagueChannelBinding: {
      findUnique: leagueBindingFindUnique,
      upsert: leagueBindingUpsert,
    },
    eventChannelBinding: {
      findUnique: eventBindingFindUnique,
      upsert: eventBindingUpsert,
    },
  },
}));

import { bindDiscordToEvent, EVENT_BIND_LEAGUE_CONFLICT } from './event-binding.js';
import { bindDiscordToLeague } from '../league/league-binding.js';
import { LEAGUE_BIND_EVENT_CONFLICT } from './event-binding.js';
import { MatchServiceError } from '../match/match-service.js';

describe('event/league bind mutual exclusion', () => {
  beforeEach(() => {
    leagueBindingFindUnique.mockReset();
    eventBindingUpsert.mockReset();
    eventBindingFindUnique.mockReset();
    leagueBindingUpsert.mockReset();
  });

  it('rejects event bind when league-bound', async () => {
    leagueBindingFindUnique.mockResolvedValue({ discordId: 'chan-1' });

    await expect(
      bindDiscordToEvent({ eventId: 'e1', discordId: 'chan-1', kind: 'CHANNEL' }),
    ).rejects.toBeInstanceOf(MatchServiceError);
    await expect(
      bindDiscordToEvent({ eventId: 'e1', discordId: 'chan-1', kind: 'CHANNEL' }),
    ).rejects.toThrow(EVENT_BIND_LEAGUE_CONFLICT);
    expect(eventBindingUpsert).not.toHaveBeenCalled();
  });

  it('rejects league bind when event-bound', async () => {
    eventBindingFindUnique.mockResolvedValue({ discordId: 'chan-1' });

    await expect(
      bindDiscordToLeague({ leagueId: 'l1', discordId: 'chan-1', kind: 'CHANNEL' }),
    ).rejects.toThrow(LEAGUE_BIND_EVENT_CONFLICT);
    expect(leagueBindingUpsert).not.toHaveBeenCalled();
  });

  it('upserts event bind when free', async () => {
    leagueBindingFindUnique.mockResolvedValue(null);
    eventBindingUpsert.mockResolvedValue({});

    await bindDiscordToEvent({ eventId: 'e1', discordId: 'chan-1', kind: 'CHANNEL' });

    expect(eventBindingUpsert).toHaveBeenCalled();
  });
});
