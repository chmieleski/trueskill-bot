/** Candidate for a hero champion Discord role (eligible, Discord-linked). */
export type HeroChampionCandidate = {
  discordId: string;
  ki: number;
  username: string;
};

/**
 * Pick the Discord user who should hold the #1 hero role.
 * Sticky incumbent: when the incumbent still has the top ki (including ties), keep them.
 */
export function pickHeroChampion(input: {
  candidates: HeroChampionCandidate[];
  incumbentDiscordId: string | null;
}): string | null {
  const { candidates, incumbentDiscordId } = input;
  if (candidates.length === 0) {
    return null;
  }

  const maxKi = Math.max(...candidates.map((c) => c.ki));
  const tied = candidates
    .filter((c) => c.ki === maxKi)
    .sort((a, b) => a.username.localeCompare(b.username));

  if (incumbentDiscordId && tied.some((c) => c.discordId === incumbentDiscordId)) {
    return incumbentDiscordId;
  }

  return tied[0]?.discordId ?? null;
}
