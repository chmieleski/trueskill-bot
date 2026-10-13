import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import {
  initialLobbyDraftState,
  type LobbyDraftParticipant,
  type LobbyDraftState,
} from './draft-types.js';

export const PROFILE = getGameProfile(WARCRAFT3_UDBR_GAME_ID);

export function person(nick: string, linked = true): LobbyDraftParticipant {
  return { key: nick.toLowerCase(), nick, ...(linked ? { discordId: `id-${nick}` } : {}) };
}

/** Draft past the coin flip: teams[0] = first nick, teams[1] = second, rest in pool. */
export function pickingState(nicks: string[], firstPickTeam: 0 | 1 = 0): LobbyDraftState {
  const participants = nicks.map((n) => person(n));
  const [a, b, ...rest] = participants;
  return {
    ...initialLobbyDraftState(participants, null),
    phase: 'PICK',
    teams: [
      { captainKey: a!.key, roster: [a!.key], side: null },
      { captainKey: b!.key, roster: [b!.key], side: null },
    ],
    firstPickTeam,
    sideChooserTeam: firstPickTeam === 0 ? 1 : 0,
    pool: rest.map((p) => p.key),
  };
}
