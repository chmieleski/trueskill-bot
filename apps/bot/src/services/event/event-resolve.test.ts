import { beforeEach, describe, expect, it, vi } from 'vitest';

const { bindingFindUnique } = vi.hoisted(() => ({
  bindingFindUnique: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    eventChannelBinding: {
      findUnique: bindingFindUnique,
    },
  },
}));

import { resolveEventContext } from './event-resolve.js';

const GUILD = 'guild-1';
const OTHER = 'guild-2';

const event1 = {
  id: 'event-1',
  guildId: GUILD,
  gameId: 'warcraft3_udbr',
  name: 'Summer Cup',
  status: 'ACTIVE' as const,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

describe('resolveEventContext', () => {
  beforeEach(() => {
    bindingFindUnique.mockReset();
  });

  it('returns event from channel binding', async () => {
    bindingFindUnique.mockResolvedValueOnce({
      eventId: 'event-1',
      discordId: 'chan-1',
      kind: 'CHANNEL',
      event: event1,
    });

    const result = await resolveEventContext({
      guildId: GUILD,
      channelId: 'chan-1',
    });

    expect(result).toEqual({ ok: true, event: event1 });
  });

  it('returns event from category binding when channel unbound', async () => {
    bindingFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      eventId: 'event-1',
      discordId: 'cat-1',
      kind: 'CATEGORY',
      event: event1,
    });

    const result = await resolveEventContext({
      guildId: GUILD,
      channelId: 'chan-1',
      categoryId: 'cat-1',
    });

    expect(result).toEqual({ ok: true, event: event1 });
  });

  it('rejects binding from another guild', async () => {
    bindingFindUnique.mockResolvedValueOnce({
      eventId: 'event-1',
      discordId: 'chan-1',
      kind: 'CHANNEL',
      event: { ...event1, guildId: OTHER },
    });

    const result = await resolveEventContext({
      guildId: GUILD,
      channelId: 'chan-1',
    });

    expect(result).toEqual({ ok: false, reason: 'not_in_guild' });
  });

  it('returns no_binding when unbound', async () => {
    bindingFindUnique.mockResolvedValue(null);

    const result = await resolveEventContext({
      guildId: GUILD,
      channelId: 'chan-1',
      categoryId: 'cat-1',
    });

    expect(result).toEqual({ ok: false, reason: 'no_binding' });
  });
});
