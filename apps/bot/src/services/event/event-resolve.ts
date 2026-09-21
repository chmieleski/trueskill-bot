import type { Event } from '@dbz/db';
import { prisma } from '../../lib/prisma.js';

export type EventResolveInput = {
  guildId: string;
  channelId?: string | null;
  categoryId?: string | null;
};

export type EventResolveResult =
  { ok: true; event: Event } | { ok: false; reason: 'no_binding' | 'not_in_guild' };

/**
 * Resolve an Event from channel/category binding only (no sole-event fallback).
 * Channel binding wins over category.
 */
export async function resolveEventContext(input: EventResolveInput): Promise<EventResolveResult> {
  if (input.channelId) {
    const binding = await prisma.eventChannelBinding.findUnique({
      where: { discordId: input.channelId },
      include: { event: true },
    });
    if (binding?.kind === 'CHANNEL') {
      if (binding.event.guildId !== input.guildId) {
        return { ok: false, reason: 'not_in_guild' };
      }
      return { ok: true, event: binding.event };
    }
  }

  if (input.categoryId) {
    const binding = await prisma.eventChannelBinding.findUnique({
      where: { discordId: input.categoryId },
      include: { event: true },
    });
    if (binding?.kind === 'CATEGORY') {
      if (binding.event.guildId !== input.guildId) {
        return { ok: false, reason: 'not_in_guild' };
      }
      return { ok: true, event: binding.event };
    }
  }

  return { ok: false, reason: 'no_binding' };
}
