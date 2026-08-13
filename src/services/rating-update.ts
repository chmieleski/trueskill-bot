import { rate, rating, type Rating } from 'openskill';
import { MatchServiceError } from './match-service.js';
import { splitRosterByTeam } from './rating-math.js';

export const QUITTER_SYNTHETIC_LOSSES = 3;

/** Strong fixed opponent for quitter penalties (not persisted). */
export function buildDummyOpponentTeam(): Rating[] {
  return [
    rating({ mu: 40, sigma: 4 }),
    rating({ mu: 40, sigma: 4 }),
  ];
}

/**
 * Run OpenSkill rate() N times: playerTeam loses to dummy each iteration.
 * Returns the updated playerTeam ratings (same length/order).
 */
export function applySyntheticLosses(
  playerTeam: Rating[],
  losses: number = QUITTER_SYNTHETIC_LOSSES,
): Rating[] {
  let current = playerTeam;
  const dummy = buildDummyOpponentTeam();

  for (let i = 0; i < losses; i += 1) {
    const [nextPlayerTeam] = rate([current, dummy], { rank: [2, 1] });
    current = nextPlayerTeam!;
  }

  return current;
}

export function partitionRosterForRating<T extends { isQuitter: boolean }>(
  entries: T[],
): { quitters: T[]; active: T[] } {
  return {
    quitters: entries.filter((e) => e.isQuitter),
    active: entries.filter((e) => !e.isQuitter),
  };
}

export function assertBothTeamsHaveActivePlayers(
  active: { slot: number }[],
): void {
  const { teamA, teamB } = splitRosterByTeam(active);
  if (teamA.length === 0 || teamB.length === 0) {
    throw new MatchServiceError(
      'Cannot complete: after quitters, a team has no remaining players. Cancel the match instead.',
    );
  }
}
