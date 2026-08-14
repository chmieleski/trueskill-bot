import type { LobbyPlayer } from './lobby-ocr.js';
import { MatchServiceError } from '../match/match-service.js';
import { normalizeNick } from '../player/player-nick.js';

const MIN_SLOT = 1;
const MAX_SLOT = 12;

const ALREADY_IN_LOBBY_LEAVE_FIRST = (slot: number) =>
  `You are already in slot ${slot}. Leave first.`;
const NOT_IN_LOBBY_MESSAGE = 'You are not in this lobby.';

function assertSlotInRange(slot: number): void {
  if (!Number.isInteger(slot) || slot < MIN_SLOT || slot > MAX_SLOT) {
    throw new MatchServiceError(
      `Invalid slot ${slot}. Slots must be between ${MIN_SLOT} and ${MAX_SLOT}.`,
    );
  }
}

export function addPlayer(players: LobbyPlayer[], nickRaw: string, slot: number): LobbyPlayer[] {
  const nick = normalizeNick(nickRaw);

  if (nick === '') {
    throw new MatchServiceError('Nick cannot be empty.');
  }

  assertSlotInRange(slot);

  if (players.some((player) => player.slot === slot)) {
    throw new MatchServiceError(`Slot ${slot} is already occupied.`);
  }

  if (players.some((player) => player.nick === nick)) {
    throw new MatchServiceError(`Nick "${nick}" is already in the lobby.`);
  }

  return [...players, { slot, nick }];
}

export function removePlayer(
  players: LobbyPlayer[],
  options: { nick?: string | null; slot?: number | null },
): LobbyPlayer[] {
  const nickRaw = options.nick?.trim() ?? '';
  const hasNick = nickRaw !== '';
  const hasSlot = options.slot !== undefined && options.slot !== null;

  if (!hasNick && !hasSlot) {
    throw new MatchServiceError('Provide a nick and/or slot to remove.');
  }

  let target: LobbyPlayer | undefined;

  if (hasSlot) {
    const slot = options.slot!;
    assertSlotInRange(slot);
    target = players.find((player) => player.slot === slot);

    if (!target) {
      throw new MatchServiceError(`Slot ${slot} is empty.`);
    }

    if (hasNick) {
      const nick = normalizeNick(nickRaw);

      if (target.nick !== nick) {
        throw new MatchServiceError(
          `Slot ${slot} is occupied by "${target.nick}", not "${nick}".`,
        );
      }
    }
  } else {
    const nick = normalizeNick(nickRaw);
    target = players.find((player) => player.nick === nick);

    if (!target) {
      throw new MatchServiceError(`No player with nick "${nick}" in the lobby.`);
    }
  }

  return players.filter((player) => player.slot !== target!.slot);
}

export function movePlayer(
  players: LobbyPlayer[],
  fromSlot: number,
  toSlot: number,
): LobbyPlayer[] {
  assertSlotInRange(fromSlot);
  assertSlotInRange(toSlot);

  if (fromSlot === toSlot) {
    throw new MatchServiceError('Choose a different slot to move into.');
  }

  if (!players.some((player) => player.slot === fromSlot)) {
    throw new MatchServiceError(`Slot ${fromSlot} is empty.`);
  }

  // Occupied destination → swap (Change Slot / relocate UX).
  if (players.some((player) => player.slot === toSlot)) {
    return swapPlayers(players, fromSlot, toSlot);
  }

  return players.map((player) =>
    player.slot === fromSlot ? { ...player, slot: toSlot } : player,
  );
}

export function swapPlayers(
  players: LobbyPlayer[],
  slotA: number,
  slotB: number,
): LobbyPlayer[] {
  assertSlotInRange(slotA);
  assertSlotInRange(slotB);

  if (slotA === slotB) {
    throw new MatchServiceError('Choose two different slots to swap.');
  }

  const playerA = players.find((player) => player.slot === slotA);
  const playerB = players.find((player) => player.slot === slotB);

  if (!playerA) {
    throw new MatchServiceError(`Slot ${slotA} is empty.`);
  }

  if (!playerB) {
    throw new MatchServiceError(`Slot ${slotB} is empty.`);
  }

  return players.map((player) => {
    if (player.slot === slotA) {
      return { ...player, slot: slotB };
    }

    if (player.slot === slotB) {
      return { ...player, slot: slotA };
    }

    return player;
  });
}

export function editPlayerNick(
  players: LobbyPlayer[],
  slot: number,
  nickRaw: string,
): LobbyPlayer[] {
  assertSlotInRange(slot);

  const nick = normalizeNick(nickRaw);

  if (nick === '') {
    throw new MatchServiceError('Nick cannot be empty.');
  }

  if (!players.some((player) => player.slot === slot)) {
    throw new MatchServiceError('That player is no longer in the lobby.');
  }

  if (players.some((player) => player.nick === nick && player.slot !== slot)) {
    throw new MatchServiceError(`Nick "${nick}" is already in the lobby.`);
  }

  return players.map((player) => (player.slot === slot ? { ...player, nick } : player));
}

/**
 * Seat a linked nick in an empty slot. Rejects occupied slots and nicks already in the lobby.
 */
export function rosterAfterClaim(
  players: LobbyPlayer[],
  nickRaw: string,
  slot: number,
): LobbyPlayer[] {
  const nick = normalizeNick(nickRaw);
  const existing = players.find((player) => player.nick === nick);

  if (existing) {
    if (existing.slot === slot) {
      throw new MatchServiceError(`You are already in slot ${slot}.`);
    }

    throw new MatchServiceError(ALREADY_IN_LOBBY_LEAVE_FIRST(existing.slot));
  }

  const occupant = players.find((player) => player.slot === slot);

  if (occupant) {
    throw new MatchServiceError(`Slot ${slot} is already occupied by "${occupant.nick}".`);
  }

  return addPlayer(players, nickRaw, slot);
}

/**
 * Remove the linked nick from the lobby (self-leave).
 */
export function rosterAfterLeave(players: LobbyPlayer[], nickRaw: string): LobbyPlayer[] {
  const nick = normalizeNick(nickRaw);
  const existing = players.find((player) => player.nick === nick);

  if (!existing) {
    throw new MatchServiceError(NOT_IN_LOBBY_MESSAGE);
  }

  return removePlayer(players, { nick });
}
