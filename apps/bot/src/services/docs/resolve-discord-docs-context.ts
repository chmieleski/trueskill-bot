import type { League } from '@dbz/db';
import type { GameProfile } from '../../domain/game-profile.js';
import { getGameProfileForLeague } from '../league/league-profile.js';
import { leagueResolveFailureMessage } from '../league/league-interaction.js';
import { resolveLeagueContext } from '../league/league-resolve.js';
import {
  isLeagueWc3statsHostPromptReady,
  isLeagueWc3statsImportReady,
  resolveLeagueConfig,
  type ResolvedLeagueConfig,
} from '../league/league-wc3stats.js';
import { DocsServiceError } from './docs-errors.js';

export type DiscordDocsRenderContext = {
  leagueId: string;
  leagueName: string;
  gameId: string;
  gameDisplayName: string;
  ratingLabel: string;
  team1: string;
  team2: string;
  teamAMaxSlot: number;
  slotCount: number;
  team1Slots: string;
  team2Slots: string;
  slotBound: boolean;
  wc3stats: boolean;
  hostPrompts: boolean;
  playerClaim: boolean;
  rankReset: boolean;
  sideWinLoss: boolean;
  heroLeaderboards: boolean;
  /** WOS leagues with uploaded bot match reports (`/hero`, `/items`). */
  wosMatchStats: boolean;
};

/** Format an inclusive slot range for docs (e.g. 1–6). */
export function formatSlotRange(start: number, end: number): string {
  return `${start}–${end}`;
}

/** Build render flags from a league row, game profile, and resolved config. */
export function buildDiscordDocsRenderContext(
  league: Pick<League, 'id' | 'name'>,
  profile: GameProfile,
  leagueConfig: ResolvedLeagueConfig,
): DiscordDocsRenderContext {
  const team2Start = profile.teamAMaxSlot + 1;

  return {
    leagueId: league.id,
    leagueName: league.name,
    gameId: profile.gameId,
    gameDisplayName: profile.displayName,
    ratingLabel: profile.ratingLabel,
    team1: profile.teamNames[1],
    team2: profile.teamNames[2],
    teamAMaxSlot: profile.teamAMaxSlot,
    slotCount: profile.slotCount,
    team1Slots: formatSlotRange(1, profile.teamAMaxSlot),
    team2Slots: formatSlotRange(team2Start, profile.slotCount),
    slotBound: profile.heroBinding === 'slot_bound',
    wc3stats: isLeagueWc3statsImportReady(leagueConfig),
    hostPrompts: isLeagueWc3statsHostPromptReady(leagueConfig),
    playerClaim: leagueConfig.lobbyPlayerClaimEnabled,
    rankReset: leagueConfig.rankResetEnabled,
    sideWinLoss: leagueConfig.showSideWinLoss,
    heroLeaderboards: profile.heroBinding === 'slot_bound',
    wosMatchStats: profile.postMatchStats === 'wos2_bot_v1',
  };
}

/**
 * Resolve league + game profile + league config for personalized Discord guides.
 * Uses the target docs channel binding when no explicit league option is passed.
 */
export async function resolveDiscordDocsContext(input: {
  guildId: string;
  channelId?: string | null;
  categoryId?: string | null;
  leagueIdOption?: string | null;
}): Promise<DiscordDocsRenderContext> {
  const resolved = await resolveLeagueContext({
    guildId: input.guildId,
    channelId: input.channelId,
    categoryId: input.categoryId,
    leagueIdOption: input.leagueIdOption ?? null,
  });

  if (!resolved.ok) {
    throw new DocsServiceError(leagueResolveFailureMessage(resolved.reason));
  }

  const [profile, leagueConfig] = await Promise.all([
    getGameProfileForLeague(resolved.league.id),
    resolveLeagueConfig(resolved.league.id),
  ]);

  return buildDiscordDocsRenderContext(resolved.league, profile, leagueConfig);
}
