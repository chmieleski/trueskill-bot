import type { Prisma } from '@dbz/db';
import { prisma } from '../../lib/prisma.js';
import { parseLobbyDraftState } from './draft-state.js';
import { participantKey, type LobbyDraftState } from './draft-types.js';

type Tx = Prisma.TransactionClient;

/**
 * Clash weight per participant key: 1 + `PlayerRating.heroPickLosses` in this league.
 * Players without a rating row (or unknown nicks) weigh 1.
 */
export async function loadHeroWeights(
  leagueId: string,
  state: LobbyDraftState,
): Promise<Record<string, number>> {
  const rows = await prisma.playerRating.findMany({
    where: {
      leagueId,
      player: { username: { in: state.participants.map((p) => p.nick), mode: 'insensitive' } },
    },
    select: { heroPickLosses: true, player: { select: { username: true } } },
  });
  const losses = new Map(rows.map((r) => [participantKey(r.player.username), r.heroPickLosses]));
  return Object.fromEntries(state.participants.map((p) => [p.key, 1 + (losses.get(p.key) ?? 0)]));
}

/**
 * What a completed match does to each drafted player's counter:
 * - played one of their picks → `reset`
 * - picked heroes, lost them all in the draft (`random`) and played something else → `increment`
 * - no picks, or got a pick and swapped away later → unchanged (absent)
 */
export function heroPickLossUpdates(
  state: LobbyDraftState,
  playedHeroByKey: ReadonlyMap<string, number | null>,
): Map<string, 'increment' | 'reset'> {
  const updates = new Map<string, 'increment' | 'reset'>();
  for (const [key, played] of playedHeroByKey) {
    const prefs = state.heroPrefs[key] ?? [];
    if (prefs.length === 0) continue;
    if (played != null && prefs.includes(played)) {
      updates.set(key, 'reset');
    } else if (state.heroResult?.[key]?.how === 'random') {
      updates.set(key, 'increment');
    }
  }
  return updates;
}

/**
 * On match completion (inside the completion transaction): apply hero pick loss
 * updates from the match's finished captain draft. No-op when the lobby was not drafted.
 * Rating rows must already exist (`ensurePlayerRatings`).
 */
export async function applyHeroPickLosses(
  tx: Tx,
  matchId: string,
  leagueId: string,
  players: ReadonlyArray<{ playerId: string; heroId: number | null; player: { username: string } }>,
): Promise<void> {
  const draft = await tx.lobbyDraft.findFirst({
    where: { matchId, status: 'COMPLETE' },
    orderBy: { updatedAt: 'desc' },
  });
  if (!draft) return;
  const playerIdByKey = new Map(
    players.map((p) => [participantKey(p.player.username), p.playerId]),
  );
  const updates = heroPickLossUpdates(
    parseLobbyDraftState(draft),
    new Map(players.map((p) => [participantKey(p.player.username), p.heroId])),
  );
  for (const [key, update] of updates) {
    await tx.playerRating.update({
      where: { leagueId_playerId: { leagueId, playerId: playerIdByKey.get(key)! } },
      data: { heroPickLosses: update === 'reset' ? 0 : { increment: 1 } },
    });
  }
}
