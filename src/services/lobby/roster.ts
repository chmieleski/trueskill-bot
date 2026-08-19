import type { GameProfile, TeamId } from '../../domain/game-profile.js';
import { invalidSlotMessage, isSlotInProfile, teamForSlot } from '../../domain/game-profile.js';
import type { LobbyPlayer } from './lobby-ocr.js';
import { MatchServiceError } from '../match/match-service.js';
import { normalizeNick } from '../player/player-nick.js';

const ALREADY_IN_LOBBY_LEAVE_FIRST = (slot: number) =>
  `You are already in slot ${slot}. Leave first.`;
const NOT_IN_LOBBY_MESSAGE = 'You are not in this lobby.';

function assertSlotInRange(slot: number, profile: GameProfile): void {
  if (!isSlotInProfile(profile, slot)) {
    throw new MatchServiceError(invalidSlotMessage(profile));
  }
}

/**
 * Parse host team input for optional_in_game add (1/2, A/B, or profile team name).
 */
export function parseTeamInput(raw: string, profile: GameProfile): TeamId {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') {
    throw new MatchServiceError(
      `Enter 1 (${profile.teamNames[1]}) or 2 (${profile.teamNames[2]}).`,
    );
  }

  if (trimmed === '1' || trimmed === 'a' || trimmed === 'team a' || trimmed === 'team 1') {
    return 1;
  }
  if (trimmed === '2' || trimmed === 'b' || trimmed === 'team b' || trimmed === 'team 2') {
    return 2;
  }

  const name1 = profile.teamNames[1].toLowerCase();
  const name2 = profile.teamNames[2].toLowerCase();
  if (trimmed === name1) {
    return 1;
  }
  if (trimmed === name2) {
    return 2;
  }

  throw new MatchServiceError(`Enter 1 (${profile.teamNames[1]}) or 2 (${profile.teamNames[2]}).`);
}

/** Lowest empty slot on the given team, or throw if that team is full. */
export function nextEmptySlotOnTeam(
  players: LobbyPlayer[],
  profile: GameProfile,
  team: TeamId,
): number {
  const occupied = new Set(players.map((player) => player.slot));

  for (let slot = 1; slot <= profile.slotCount; slot += 1) {
    if (teamForSlot(profile, slot) !== team) {
      continue;
    }
    if (!occupied.has(slot)) {
      return slot;
    }
  }

  throw new MatchServiceError(`${profile.teamNames[team]} is full.`);
}

export function addPlayer(
  players: LobbyPlayer[],
  nickRaw: string,
  slot: number,
  profile: GameProfile,
): LobbyPlayer[] {
  const nick = normalizeNick(nickRaw);

  if (nick === '') {
    throw new MatchServiceError('Nick cannot be empty.');
  }

  assertSlotInRange(slot, profile);

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
  profile: GameProfile,
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
    assertSlotInRange(slot, profile);
    target = players.find((player) => player.slot === slot);

    if (!target) {
      throw new MatchServiceError(`Slot ${slot} is empty.`);
    }

    if (hasNick) {
      const nick = normalizeNick(nickRaw);

      if (target.nick !== nick) {
        throw new MatchServiceError(`Slot ${slot} is occupied by "${target.nick}", not "${nick}".`);
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
  profile: GameProfile,
): LobbyPlayer[] {
  assertSlotInRange(fromSlot, profile);
  assertSlotInRange(toSlot, profile);

  if (fromSlot === toSlot) {
    throw new MatchServiceError('Choose a different slot to move into.');
  }

  if (!players.some((player) => player.slot === fromSlot)) {
    throw new MatchServiceError(`Slot ${fromSlot} is empty.`);
  }

  if (players.some((player) => player.slot === toSlot)) {
    return swapPlayers(players, fromSlot, toSlot, profile);
  }

  return players.map((player) => (player.slot === fromSlot ? { ...player, slot: toSlot } : player));
}

export function swapPlayers(
  players: LobbyPlayer[],
  slotA: number,
  slotB: number,
  profile: GameProfile,
): LobbyPlayer[] {
  assertSlotInRange(slotA, profile);
  assertSlotInRange(slotB, profile);

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
  profile: GameProfile,
): LobbyPlayer[] {
  assertSlotInRange(slot, profile);

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
  profile: GameProfile,
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

  return addPlayer(players, nickRaw, slot, profile);
}

/**
 * Remove the linked nick from the lobby (self-leave).
 */
export function rosterAfterLeave(
  players: LobbyPlayer[],
  nickRaw: string,
  profile: GameProfile,
): LobbyPlayer[] {
  const nick = normalizeNick(nickRaw);
  const existing = players.find((player) => player.nick === nick);

  if (!existing) {
    throw new MatchServiceError(NOT_IN_LOBBY_MESSAGE);
  }

  return removePlayer(players, { nick }, profile);
}
