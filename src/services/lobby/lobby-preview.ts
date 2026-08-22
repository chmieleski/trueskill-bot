import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  time,
  TimestampStyles,
} from 'discord.js';
import type { LobbyPlayer, ValidatedLobby } from './lobby-ocr.js';
import { formatBalanceHints } from './lobby-balance.js';
import type { LobbyRatingPlayerLine, LobbyRatingPreview } from '../rating/rating-preview.js';
import { formatPublicKi, isCalibrating } from '../rating/rating-math.js';
import { NEW_PLAYER_ROSTER_MARKER } from '../rating/new-player.js';
import { teamDisplayName, teamDisplayNameForSlot } from '../guild/team-names.js';
import {
  getGameProfile,
  isSlotInProfile,
  teamForSlot,
  type GameProfile,
} from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';

export const LOBBY_CUSTOM_IDS = {
  start: 'lobby:start',
  editNick: 'lobby:edit_nick',
  move: 'lobby:move',
  remove: 'lobby:remove',
  add: 'lobby:add',
  claim: 'lobby:claim',
  leave: 'lobby:leave',
  refresh: 'lobby:refresh',
  cancel: 'lobby:cancel',
  reportWinner: 'match:report',
  quitters: 'match:quitters',
  griffers: 'match:griffers',
  cancelInProgress: 'match:cancel',
} as const;

/** Must match stale PENDING cleanup TTL in match-cleanup / match-service. */
export const LOBBY_PENDING_TTL_MS = 2 * 60 * 60 * 1000;

const TEAM_A_EMOJI = '🟥';
const TEAM_B_EMOJI = '🟦';
const HABITUAL_QUITTER_FOOTER_SUFFIX = ' · ⚠️ quit 50%+';

function resolvedProfile(profile?: GameProfile): GameProfile {
  return profile ?? getGameProfile(WARCRAFT3_UDBR_GAME_ID);
}

/** Real Discord embed footer (not a field) — no markdown supported here. */
function ordinalFooterText(
  ratingLabel: string,
  hideHero: boolean,
  showHabitualQuitterLegend: boolean,
): string {
  const base = hideHero
    ? `Per player: slot  nick  global (${ratingLabel})`
    : `Per player: slot  nick  global / hero (${ratingLabel})`;
  return showHabitualQuitterLegend ? `${base}${HABITUAL_QUITTER_FOOTER_SUFFIX}` : base;
}

/** Pad slot 1–12 so columns stay aligned in monospace roster lines. */
function formatSlotLabel(slot: number): string {
  return String(slot).padStart(2, ' ');
}

/** Win-chance accent: green favored, red underdog, white even. */
function winChanceEmoji(selfPercent: number, otherPercent: number): string {
  if (selfPercent > otherPercent) {
    return '🟢';
  }
  if (selfPercent < otherPercent) {
    return '🔴';
  }
  return '⚪';
}

/** Occupied nicks prefixed with lobby slot number. */
export function formatTeamLines(players: LobbyPlayer[]): string {
  if (players.length === 0) {
    return '_Empty_';
  }

  return players.map((player) => `**${player.slot}.** ${player.nick}`).join('\n');
}

/**
 * Public ki cell for a roster line. Calibrating players hide both the number
 * and any signed delta (player-level gate for global and hero).
 */
function formatKiCell(ki: number, leagueGames: number, delta: number | undefined): string {
  if (isCalibrating(leagueGames)) {
    return formatPublicKi(ki, leagueGames);
  }
  return `${ki}${formatSignedDelta(delta)}`;
}

/**
 * Format roster lines with global / hero display ki (DTO *Ordinal fields).
 * Prefixes each occupied line with the lobby slot (1–12) so hosts can add/move
 * by number. Uses monospace padding so rating columns align. When deltas are
 * present (completed match), appends signed change inline. Habitual 50%+ quit
 * lines get trailing ⚠️ outside the code span (before 🚪 / 🐛). Quitter lines
 * get a trailing 🚪 marker outside the code span; griffer lines get 🐛. New
 * players get ` · New` beside those marks.
 */
export function formatTeamLinesFromPreview(players: LobbyRatingPlayerLine[]): string {
  if (players.length === 0) {
    return '_Empty_';
  }

  const nickWidth = Math.max(8, ...players.map((player) => player.nick.length));
  const showHeroColumn = players.some((player) => player.showHero !== false);
  const cells = players.map((player) => ({
    global: formatKiCell(player.globalOrdinal, player.leagueGames, player.globalDelta),
    hero: formatKiCell(player.heroOrdinal, player.leagueGames, player.heroDelta),
  }));
  const ratingWidth = Math.max(
    4,
    ...cells.flatMap((cell) =>
      showHeroColumn ? [cell.global.length, cell.hero.length] : [cell.global.length],
    ),
  );

  return players
    .map((player, index) => {
      const slotLabel = formatSlotLabel(player.slot);
      const nick = player.nick.padEnd(nickWidth, ' ');
      const global = cells[index]!.global.padStart(ratingWidth, ' ');
      const habitualMark = player.habitualQuitter ? ' ⚠️' : '';
      const quitterMark = player.isQuitter ? ' 🚪' : '';
      const grifferMark = !player.isQuitter && player.isGriffer ? ' 🐛' : '';
      const newMark = player.isNewPlayer || player.wasNewPlayer ? NEW_PLAYER_ROSTER_MARKER : '';
      const flagMark = `${habitualMark}${quitterMark}${grifferMark}${newMark}`;
      if (player.showHero === false) {
        return `\`${slotLabel}  ${nick}   ${global}\`${flagMark}`;
      }
      const hero = cells[index]!.hero.padStart(ratingWidth, ' ');
      return `\`${slotLabel}  ${nick}   ${global} / ${hero}\`${flagMark}`;
    })
    .join('\n');
}

/** Format optional ki delta as ` (+123)` / ` (-45)`; empty when undefined. */
export function formatSignedDelta(delta: number | undefined): string {
  if (delta === undefined) {
    return '';
  }

  const sign = delta > 0 ? '+' : '';
  return ` (${sign}${delta})`;
}

export function splitLobbyPlayers(players: LobbyPlayer[], profile?: GameProfile): ValidatedLobby {
  const resolved = resolvedProfile(profile);
  const inProfile = (player: LobbyPlayer) => isSlotInProfile(resolved, player.slot);
  const teamA = players
    .filter((player) => inProfile(player) && teamForSlot(resolved, player.slot) === 1)
    .sort((a, b) => a.slot - b.slot);
  const teamB = players
    .filter((player) => inProfile(player) && teamForSlot(resolved, player.slot) === 2)
    .sort((a, b) => a.slot - b.slot);

  return { teamA, teamB };
}

function splitPreviewPlayers(
  players: LobbyRatingPlayerLine[],
  profile?: GameProfile,
): {
  teamA: LobbyRatingPlayerLine[];
  teamB: LobbyRatingPlayerLine[];
} {
  const resolved = resolvedProfile(profile);
  const inProfile = (player: LobbyRatingPlayerLine) => isSlotInProfile(resolved, player.slot);
  const teamA = players
    .filter((player) => inProfile(player) && teamForSlot(resolved, player.slot) === 1)
    .sort((a, b) => a.slot - b.slot);
  const teamB = players
    .filter((player) => inProfile(player) && teamForSlot(resolved, player.slot) === 2)
    .sort((a, b) => a.slot - b.slot);

  return { teamA, teamB };
}

/** Both teams have ≥1 human using the profile slot split (not OCR 12-slot rules). */
export function canStartLobby(players: LobbyPlayer[], profile?: GameProfile): boolean {
  const { teamA, teamB } = splitLobbyPlayers(players, profile);
  return teamA.length >= 1 && teamB.length >= 1;
}

/**
 * Win-chance row: two inline fields + blank spacer so Discord keeps a clean
 * two-column row (embeds lay out inline fields in groups of three).
 */
function ratingPreviewFields(preview: LobbyRatingPreview | undefined, profile?: GameProfile) {
  if (!preview?.winChance) {
    return [];
  }

  const { teamAPercent, teamBPercent } = preview.winChance;
  return [
    {
      name: '\u200b',
      value: '\u200b',
      inline: false,
    },
    {
      name: `${TEAM_A_EMOJI} ${teamDisplayName(1, profile)} win`,
      value: `${winChanceEmoji(teamAPercent, teamBPercent)} **${teamAPercent}%**`,
      inline: true,
    },
    {
      name: '\u200b',
      value: '\u200b',
      inline: true,
    },
    {
      name: `${TEAM_B_EMOJI} ${teamDisplayName(2, profile)} win`,
      value: `${winChanceEmoji(teamBPercent, teamAPercent)} **${teamBPercent}%**`,
      inline: true,
    },
  ];
}

/** Shown under Balance hint(s). Suggestions come from ratings; the host decides seating. */
export const BALANCE_HINT_DISCLAIMER = '_Based on ratings — the host has the last word._';

function balanceHintFields(preview: LobbyRatingPreview | undefined) {
  const suggestions = preview?.balanceSuggestions;
  if (!suggestions || suggestions.length === 0) {
    return [];
  }
  return [
    {
      name: 'Balance hint',
      value: `${formatBalanceHints(suggestions)}\n${BALANCE_HINT_DISCLAIMER}`,
      inline: false,
    },
  ];
}

function teamFieldValues(
  players: LobbyPlayer[],
  ratingPreview: LobbyRatingPreview | undefined,
  profile?: GameProfile,
): { teamAValue: string; teamBValue: string; teamACount: number; teamBCount: number } {
  if (ratingPreview) {
    const { teamA, teamB } = splitPreviewPlayers(ratingPreview.players, profile);
    return {
      teamAValue: formatTeamLinesFromPreview(teamA),
      teamBValue: formatTeamLinesFromPreview(teamB),
      teamACount: teamA.length,
      teamBCount: teamB.length,
    };
  }

  const { teamA, teamB } = splitLobbyPlayers(players, profile);
  return {
    teamAValue: formatTeamLines(teamA),
    teamBValue: formatTeamLines(teamB),
    teamACount: teamA.length,
    teamBCount: teamB.length,
  };
}

function ordinalFooter(
  preview: LobbyRatingPreview | undefined,
  profile: GameProfile,
): string | undefined {
  if (!preview) {
    return undefined;
  }
  const hideHero =
    profile.heroBinding === 'optional_in_game' ||
    preview.players.some((player) => player.showHero === false);
  return ordinalFooterText(
    profile.ratingLabel,
    hideHero,
    preview.players.some((player) => player.habitualQuitter === true),
  );
}

/** Shared chrome: author (match id), footer legend, timestamp. */
function applyEmbedChrome(
  embed: EmbedBuilder,
  options: {
    matchId: string;
    ratingPreview?: LobbyRatingPreview;
    profile: GameProfile;
    timestamp?: Date;
  },
): EmbedBuilder {
  embed.setAuthor({ name: `Match ${options.matchId}` });

  const footer = ordinalFooter(options.ratingPreview, options.profile);
  if (footer) {
    embed.setFooter({ text: footer });
  }

  if (options.timestamp) {
    embed.setTimestamp(options.timestamp);
  }

  return embed;
}

export function buildMatchLobbyEmbed(
  matchId: string,
  players: LobbyPlayer[],
  options: {
    canStart?: boolean;
    createdAt?: Date;
    ratingPreview?: LobbyRatingPreview;
    wc3statsGameId?: string | null;
    wc3statsUnavailable?: boolean;
    wc3statsLinkAvailable?: boolean;
    profile?: GameProfile;
  } = {},
): EmbedBuilder {
  const profile = resolvedProfile(options.profile);
  const canStart = options.canStart ?? canStartLobby(players, profile);
  const createdAt = options.createdAt ?? new Date();
  const expiresAt = new Date(createdAt.getTime() + LOBBY_PENDING_TTL_MS);
  const expiresLine = `Expires ${time(expiresAt, TimestampStyles.RelativeTime)}`;
  const { teamAValue, teamBValue, teamACount, teamBCount } = teamFieldValues(
    players,
    options.ratingPreview,
    profile,
  );

  const descriptionLines = [
    canStart
      ? 'Review the lobby, then start when ready.'
      : 'Add at least one human player to each team before starting.',
    expiresLine,
  ];

  if (options.wc3statsUnavailable) {
    descriptionLines.push('Could not read the Warcraft lobby. Add players or attach a screenshot.');
  } else if (options.wc3statsGameId) {
    descriptionLines.push(
      players.length === 0
        ? 'wc3stats has not published the player list yet. Use Refresh, a screenshot, or add players.'
        : 'Source: wc3stats',
    );
  } else if (options.wc3statsLinkAvailable) {
    descriptionLines.push(
      'Use Refresh to attach the live Warcraft lobby. The host Discord must be linked with /link and seated in that lobby.',
    );
  }

  const embed = new EmbedBuilder()
    .setTitle('Match Lobby')
    .setDescription(descriptionLines.join('\n'))
    .addFields(
      {
        name: `${TEAM_A_EMOJI} ${teamDisplayName(1, profile)} (${teamACount})`,
        value: teamAValue,
        inline: false,
      },
      {
        name: `${TEAM_B_EMOJI} ${teamDisplayName(2, profile)} (${teamBCount})`,
        value: teamBValue,
        inline: false,
      },
      ...ratingPreviewFields(options.ratingPreview, profile),
      ...balanceHintFields(options.ratingPreview),
    )
    .setColor(0x5865f2);

  return applyEmbedChrome(embed, {
    matchId,
    ratingPreview: options.ratingPreview,
    profile,
    timestamp: createdAt,
  });
}

export function buildMatchInProgressEmbed(
  matchId: string,
  players: LobbyPlayer[],
  options: { ratingPreview?: LobbyRatingPreview; profile?: GameProfile } = {},
): EmbedBuilder {
  const profile = resolvedProfile(options.profile);
  const { teamAValue, teamBValue, teamACount, teamBCount } = teamFieldValues(
    players,
    options.ratingPreview,
    profile,
  );

  const embed = new EmbedBuilder()
    .setTitle('Match In Progress')
    .setDescription('Match has started. Report the result when finished.')
    .addFields(
      {
        name: `${TEAM_A_EMOJI} ${teamDisplayName(1, profile)} (${teamACount})`,
        value: teamAValue,
        inline: false,
      },
      {
        name: `${TEAM_B_EMOJI} ${teamDisplayName(2, profile)} (${teamBCount})`,
        value: teamBValue,
        inline: false,
      },
      ...ratingPreviewFields(options.ratingPreview, profile),
    )
    .setColor(0x57f287);

  return applyEmbedChrome(embed, {
    matchId,
    ratingPreview: options.ratingPreview,
    profile,
    timestamp: new Date(),
  });
}

export function buildMatchReportButtons(): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(LOBBY_CUSTOM_IDS.reportWinner)
        .setLabel('Report Winner')
        .setEmoji('🏆')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(LOBBY_CUSTOM_IDS.quitters)
        .setLabel('Quitters')
        .setEmoji('🚪')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(LOBBY_CUSTOM_IDS.griffers)
        .setLabel('Abuser')
        .setEmoji('🐛')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(LOBBY_CUSTOM_IDS.cancelInProgress)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export function buildMatchCompletedEmbed(
  matchId: string,
  players: LobbyPlayer[],
  options: {
    ratingPreview?: LobbyRatingPreview;
    winningTeam: 1 | 2;
    profile?: GameProfile;
    /** Defaults to now; prefer match.completedAt for historical show. */
    timestamp?: Date;
  },
): EmbedBuilder {
  const profile = resolvedProfile(options.profile);
  const { teamAValue, teamBValue, teamACount, teamBCount } = teamFieldValues(
    players,
    options.ratingPreview,
    profile,
  );
  const winnerLabel = teamDisplayName(options.winningTeam, profile);
  const color = options.winningTeam === 1 ? 0xf1c40f : 0x57f287;

  const ratingNote = options.ratingPreview
    ? ''
    : '\n_Rating changes were not recorded for this match._';

  const embed = new EmbedBuilder()
    .setTitle('Match Completed')
    .setDescription(`${winnerLabel} won the match.${ratingNote}`)
    .addFields(
      {
        name: `${TEAM_A_EMOJI} ${teamDisplayName(1, profile)} (${teamACount})`,
        value: teamAValue,
        inline: false,
      },
      {
        name: `${TEAM_B_EMOJI} ${teamDisplayName(2, profile)} (${teamBCount})`,
        value: teamBValue,
        inline: false,
      },
      ...ratingPreviewFields(options.ratingPreview, profile),
    )
    .setColor(color);

  return applyEmbedChrome(embed, {
    matchId,
    ratingPreview: options.ratingPreview,
    profile,
    timestamp: options.timestamp ?? new Date(),
  });
}

export function buildMatchCancelledEmbed(
  matchId: string,
  reason: string = 'expired',
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Match Cancelled')
    .setAuthor({ name: `Match ${matchId}` })
    .setDescription(`This match was cancelled (${reason}).`)
    .setColor(0xed4245)
    .setTimestamp(new Date());
}

/** Empty-slot options for player claim. Slot-bound games include the hero name. */
export function claimSlotSelectOptions(
  players: LobbyPlayer[],
  heroNameForSlot: (slot: number) => string,
  profile?: GameProfile,
): { label: string; value: string }[] {
  const resolved = resolvedProfile(profile);
  const occupied = new Set(players.map((player) => player.slot));
  const options: { label: string; value: string }[] = [];

  for (let slot = 1; slot <= resolved.slotCount; slot += 1) {
    if (occupied.has(slot)) {
      continue;
    }

    const suffix =
      resolved.heroBinding === 'slot_bound'
        ? heroNameForSlot(slot)
        : teamDisplayNameForSlot(slot, resolved);
    options.push({
      label: `Slot ${slot} · ${suffix}`.slice(0, 100),
      value: String(slot),
    });
  }

  return options;
}

export function buildLobbyButtons(
  options: {
    canStart?: boolean;
    locked?: boolean;
    playerCount?: number;
    playerClaimEnabled?: boolean;
    wc3statsGameId?: string | null;
    wc3statsEnabled?: boolean;
    profile?: GameProfile;
  } = {},
): ActionRowBuilder<ButtonBuilder>[] {
  if (options.locked) {
    return [];
  }

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const playerClaimEnabled = options.playerClaimEnabled ?? true;
  const playerCount = options.playerCount ?? 0;
  const slotCount = resolvedProfile(options.profile).slotCount;
  const canAdd = playerCount < slotCount;
  const showRefresh = Boolean(options.wc3statsGameId) || Boolean(options.wc3statsEnabled);

  const refreshButton = new ButtonBuilder()
    .setCustomId(LOBBY_CUSTOM_IDS.refresh)
    .setLabel('Refresh')
    .setEmoji('🔄')
    .setStyle(ButtonStyle.Secondary);

  if (options.canStart) {
    const startRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(LOBBY_CUSTOM_IDS.start)
        .setLabel('Start Match')
        .setEmoji('▶️')
        .setStyle(ButtonStyle.Success),
    );
    if (showRefresh) {
      startRow.addComponents(refreshButton);
    }
    rows.push(startRow);
  } else if (showRefresh) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(refreshButton));
  }

  const rosterControls = [
    new ButtonBuilder()
      .setCustomId(LOBBY_CUSTOM_IDS.editNick)
      .setLabel('Edit')
      .setEmoji('✏️')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(LOBBY_CUSTOM_IDS.move)
      .setLabel('Move')
      .setEmoji('🔀')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(LOBBY_CUSTOM_IDS.remove)
      .setLabel('Remove')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger),
  ];

  if (canAdd) {
    rosterControls.push(
      new ButtonBuilder()
        .setCustomId(LOBBY_CUSTOM_IDS.add)
        .setLabel('Add')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Success),
    );
  }

  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...rosterControls));

  if (playerClaimEnabled) {
    const claimRow = new ActionRowBuilder<ButtonBuilder>();

    if (canAdd) {
      claimRow.addComponents(
        new ButtonBuilder()
          .setCustomId(LOBBY_CUSTOM_IDS.claim)
          .setLabel('Claim slot')
          .setStyle(ButtonStyle.Primary),
      );
    }

    claimRow.addComponents(
      new ButtonBuilder()
        .setCustomId(LOBBY_CUSTOM_IDS.leave)
        .setLabel('Leave')
        .setStyle(ButtonStyle.Secondary),
    );

    rows.push(claimRow);
  }

  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(LOBBY_CUSTOM_IDS.cancel)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  return rows;
}
