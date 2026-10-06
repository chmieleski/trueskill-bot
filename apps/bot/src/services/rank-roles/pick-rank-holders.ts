/** Leaderboard positions that can carry a staff-mapped Discord role. */
export const RANK_ROLE_POSITIONS = [1, 2, 3] as const;

/** Overall leaderboard row as needed for rank role picks (already sorted ki desc, username asc). */
export type RankRoleCandidate = {
  discordId: string | null;
  ki: number;
  username: string;
  /** Competition rank; null while calibrating. */
  rank: number | null;
};

/**
 * Pick the Discord user for each leaderboard position 1–3.
 * Order follows the board; on an exact ki tie, current holders stay ahead
 * (lowest held position first), so ties never shuffle roles.
 * A position whose player has no Discord link stays vacant (null).
 */
export function pickRankHolders(input: {
  entries: RankRoleCandidate[];
  incumbents: Map<number, string | null>;
}): Map<number, string | null> {
  const heldPosition = new Map<string, number>();
  for (const [position, discordId] of input.incumbents) {
    if (discordId) heldPosition.set(discordId, position);
  }
  const held = (entry: RankRoleCandidate): number =>
    (entry.discordId && heldPosition.get(entry.discordId)) || Infinity;

  const ordered = input.entries
    .filter((entry) => entry.rank !== null)
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.ki - a.entry.ki || held(a.entry) - held(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);

  return new Map(
    RANK_ROLE_POSITIONS.map((position) => [
      position,
      ordered[position - 1]?.discordId?.trim() || null,
    ]),
  );
}
