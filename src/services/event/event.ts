import type { Event, EventStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { getGameProfile, UnknownGameIdError } from '../../domain/game-profile.js';

export type { Event, EventStatus };

export const EVENT_NOT_ACTIVE_MESSAGE =
  'This event is closed. Open a new event or use an active event channel.';

export const EVENT_NOT_FOUND_MESSAGE = 'Event not found.';

/**
 * Create an ACTIVE event for a guild + game.
 */
export async function createEvent(input: {
  guildId: string;
  gameId: string;
  name: string;
}): Promise<Event> {
  const name = input.name.trim();
  if (name === '') {
    throw new Error('Event name cannot be empty.');
  }

  try {
    getGameProfile(input.gameId);
  } catch (error) {
    if (error instanceof UnknownGameIdError) {
      throw new Error(error.message);
    }
    throw error;
  }

  return prisma.event.create({
    data: {
      guildId: input.guildId,
      gameId: input.gameId,
      name,
      status: 'ACTIVE',
    },
  });
}

export async function getEventById(id: string): Promise<Event | null> {
  return prisma.event.findUnique({ where: { id } });
}

export async function listEventsForGuild(
  guildId: string,
  gameId?: string | null,
): Promise<Event[]> {
  return prisma.event.findMany({
    where: {
      guildId,
      ...(gameId ? { gameId } : {}),
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });
}

export async function setEventStatus(id: string, status: EventStatus): Promise<Event> {
  const existing = await prisma.event.findUnique({ where: { id } });
  if (!existing) {
    throw new Error(EVENT_NOT_FOUND_MESSAGE);
  }

  return prisma.event.update({
    where: { id },
    data: { status },
  });
}

export function isEventWritable(event: Pick<Event, 'status'>): boolean {
  return event.status === 'ACTIVE';
}
