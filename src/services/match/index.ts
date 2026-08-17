export {
  attachDiscordMessage,
  createPendingMatch,
  findInProgressMatchesByHost,
  getMatchById,
  MatchServiceError,
  type MatchWithPlayers,
} from './match-service.js';
export {
  cancelInProgressMatch,
  completeMatch,
  setQuitters,
  type CompleteMatchResult,
} from './match-report.js';
export {
  assertCanCreateMatch,
  assertCanManageMatch,
  assertHasMatchModRole,
  hasMatchModRole,
} from './match-auth.js';
export { startMatchCleanupScheduler, stopMatchCleanupScheduler } from './match-cleanup.js';
export {
  buildMatchHistoryEmbed,
  buildMatchHistoryPageButtons,
  buildMatchHistoryPageCustomId,
  clampMatchHistoryPage,
  formatMatchHistoryDelta,
  formatMatchHistoryField,
  formatMatchHistoryResult,
  loadCompletedMatchShow,
  loadMatchHistoryPage,
  MATCH_HISTORY_PAGE_SIZE,
  parseMatchHistoryPageCustomId,
  resolveHistoryPlayer,
  winningTeamFromPlayers,
  type MatchHistoryPage,
  type MatchHistoryRow,
} from './match-history.js';
export {
  loadPlayerGlobalDeltaForMatch,
  rebuildCompletedRatingPreview,
} from './match-history-preview.js';
export {
  CORRECTION_WINDOW_MS,
  GLOBAL_SNAPSHOT_HERO_ID,
  isWithinCorrectionWindow,
  assertMatchCorrectable,
  assertSnapshotsComplete,
  hasNewerCompletedMatches,
  restoreMatchRatingSnapshots,
  previewMatchCorrection,
  flipCompletedMatch,
  voidCompletedMatch,
  buildMatchCorrectionConfirmCustomId,
  buildMatchCorrectionCancelCustomId,
  parseMatchCorrectionButtonCustomId,
  type MatchCorrectionPreview,
  type MatchCorrectionConfirmInput,
  type MatchCorrectionButtonParsed,
} from './match-correction.js';
