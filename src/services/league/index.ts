export {
  createLeague,
  getDefaultUdbrLeagueId,
  getLeagueById,
  listLeaguesForGuild,
  type League,
} from './league.js';

export { getGameProfileForLeague, LeagueNotFoundError } from './league-profile.js';

export { bindDiscordToLeague, unbindDiscord, type LeagueBindingKind } from './league-binding.js';

export {
  resolveLeagueContext,
  type LeagueResolveInput,
  type LeagueResolveResult,
} from './league-resolve.js';

export {
  autocompleteGuildLeagues,
  getInteractionCategoryId,
  getLeagueOption,
  leagueResolveFailureMessage,
  LEAGUE_RESOLVE_AMBIGUOUS,
  LEAGUE_RESOLVE_INVALID_OPTION,
  LEAGUE_RESOLVE_NO_LEAGUES,
  LEAGUE_RESOLVE_NOT_IN_GUILD,
  resolveLeagueFromInteraction,
  resolveLeagueIdFromInteraction,
  respondLeagueAutocomplete,
  withOptionalLeagueOption,
  withSubcommandLeagueOption,
  type ResolvedLeagueId,
} from './league-interaction.js';

export {
  applyUdbrWc3statsPreset,
  clearLeagueLeaderboardChannel,
  clearLeagueLeaderboardSize,
  clearLeagueWc3statsHostPrompt,
  clearLeagueWc3statsPackage,
  isLeagueWc3statsHostPromptReady,
  isLeagueWc3statsImportReady,
  resolveLeagueConfig,
  setLeagueLeaderboardChannel,
  setLeagueLeaderboardSize,
  setLeagueLobbyPlayerClaimEnabled,
  setLeagueRankResetCooldownDays,
  setLeagueRankResetEnabled,
  setLeagueWc3statsHostPrompt,
  type ResolvedLeagueConfig,
} from './league-wc3stats.js';
