import { shuffle } from './draft-logic.js';
import { LobbyDraftError, type HeroAssignment } from './draft-types.js';

/**
 * Give as many players as possible one of their wanted heroes (maximum bipartite
 * matching, Kuhn's augmenting paths — ≤6×6 so cost is trivial). Players and wish
 * lists are shuffled first, so only real clashes are decided by chance.
 * Everyone left over gets a random free hero.
 */
export function assignHeroes(
  players: Array<{ key: string; wanted: number[] }>,
  heroes: number[],
  rng: () => number = Math.random,
): Record<string, HeroAssignment> {
  if (players.length > heroes.length) {
    throw new LobbyDraftError('Too many players for this side.');
  }
  const heroSet = new Set(heroes);
  const wanted = new Map(
    shuffle(players, rng).map((p) => [
      p.key,
      shuffle(
        p.wanted.filter((h) => heroSet.has(h)),
        rng,
      ),
    ]),
  );
  const ownerByHero = new Map<number, string>();

  const tryAssign = (key: string, seen: Set<number>): boolean => {
    for (const hero of wanted.get(key) ?? []) {
      if (seen.has(hero)) continue;
      seen.add(hero);
      const owner = ownerByHero.get(hero);
      if (owner === undefined || tryAssign(owner, seen)) {
        ownerByHero.set(hero, key);
        return true;
      }
    }
    return false;
  };
  for (const key of wanted.keys()) tryAssign(key, new Set());

  const result: Record<string, HeroAssignment> = {};
  const matchedKeys = new Set(ownerByHero.values());
  for (const [heroId, key] of ownerByHero) {
    // Contested = someone else wanted this hero and ended up with none of their wishes.
    const contested = players.some(
      (p) => p.key !== key && p.wanted.includes(heroId) && !matchedKeys.has(p.key),
    );
    result[key] = { heroId, how: contested ? 'contested' : 'wanted' };
  }
  const free = shuffle(
    heroes.filter((h) => !ownerByHero.has(h)),
    rng,
  );
  for (const key of wanted.keys()) {
    if (!result[key]) result[key] = { heroId: free.shift()!, how: 'random' };
  }
  return result;
}
