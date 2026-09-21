import { createLogger } from '../../lib/logger.js';
import type { LobbyPlayer } from '../lobby/lobby-ocr.js';
import { normalizeNick } from '../player/player-nick.js';
import type { Wc3statsSlot } from './wc3stats-client.js';
import type { Wc3statsHeroSlotMap } from './wc3stats-slot-map.js';

const log = createLogger('wc3stats-roster');

const MAX_SLOT = 12;

export type { Wc3statsSlot };

export type Wc3statsRosterResult = {
  usable: boolean;
  players: LobbyPlayer[];
  occupiedCount: number;
};

export type ExtractWc3statsRosterOptions = {
  /** When set, only mapped indices are imported. When null/undefined, legacy index+1 for 0–11. */
  slotMap?: Wc3statsHeroSlotMap | null;
};

function isOccupiedHuman(slot: Wc3statsSlot): boolean {
  return slot.status === 'occupied' && slot.isComputer !== true && slot.isObserver !== true;
}

function resolveHeroSlot(
  wc3statsIndex: number,
  slotMap: Wc3statsHeroSlotMap | null | undefined,
): number | null {
  if (slotMap && slotMap.size > 0) {
    return slotMap.get(wc3statsIndex) ?? null;
  }

  const legacy = wc3statsIndex + 1;
  if (legacy < 1 || legacy > MAX_SLOT) {
    return null;
  }
  return legacy;
}

/**
 * Map wc3stats detail slots to bot lobby players.
 * Prefer a guild slot map (wc3stats index → hero 1–12). Without a map, legacy index+1 for 0–11.
 * Empty-full payloads are marked unusable so Refresh does not wipe a Discord roster.
 */
export function extractWc3statsRoster(
  detail: {
    numPlayers?: number;
    slotsTaken?: number;
    slots?: Wc3statsSlot[];
  },
  options: ExtractWc3statsRosterOptions = {},
): Wc3statsRosterResult {
  const slots = detail.slots ?? [];
  const players: LobbyPlayer[] = [];
  const seenNicks = new Set<string>();
  const seenHeroSlots = new Set<number>();

  for (let index = 0; index < slots.length; index += 1) {
    const heroSlot = resolveHeroSlot(index, options.slotMap);
    if (heroSlot === null) {
      continue;
    }

    const slot = slots[index]!;
    if (!isOccupiedHuman(slot)) {
      continue;
    }

    const nick = normalizeNick(slot.player?.name ?? '');
    if (nick === '') {
      continue;
    }

    if (seenNicks.has(nick)) {
      log.warn({ nick, wc3statsSlot: index, heroSlot }, 'Skipping duplicate wc3stats nick');
      continue;
    }

    if (seenHeroSlots.has(heroSlot)) {
      log.warn(
        { nick, wc3statsSlot: index, heroSlot },
        'Skipping duplicate hero slot from wc3stats map',
      );
      continue;
    }

    seenNicks.add(nick);
    seenHeroSlots.add(heroSlot);
    players.push({ slot: heroSlot, nick });
  }

  players.sort((a, b) => a.slot - b.slot);

  const taken = detail.numPlayers ?? detail.slotsTaken ?? 0;
  const occupiedCount = players.length;
  const usable = occupiedCount > 0 || taken === 0;

  return { usable, players, occupiedCount };
}

/**
 * Refresh must not wipe a Discord roster when wc3stats returns an empty-full payload.
 */
export function applyWc3statsRefresh(
  current: LobbyPlayer[],
  incoming: Wc3statsRosterResult,
): { players: LobbyPlayer[]; keptExisting: boolean } {
  if (incoming.usable) {
    return { players: incoming.players, keptExisting: false };
  }

  if (current.length > 0) {
    return { players: current, keptExisting: true };
  }

  return { players: current, keptExisting: false };
}
