import { GuildMember, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import type { LobbyPlayer } from '../../services/lobby/index.js';
import {
  buildLobbyButtons,
  buildMatchLobbyEmbed,
  canStartLobby,
} from '../../services/lobby/index.js';
import { resolveGuildConfig, type ResolvedGuildConfig } from '../../services/guild/index.js';
import { nickForDiscordId } from '../../services/lobby/index.js';
import { assertCanCreateMatch, hasMatchModRole } from '../../services/match/index.js';
import {
  attachDiscordMessage,
  createPendingMatch,
  getMatchById,
  MatchServiceError,
} from '../../services/match/index.js';
import {
  loadLobbyRatingPreview,
  matchPlayersToRatingEntries,
  collectNewPlayerSuggestionsForPendingCreate,
} from '../../services/rating/index.js';
import {
  allowsEmptyMatchOnWc3statsFailure,
  isImageAttachment,
  parseWc3statsId,
  resolveMimeType,
  resolveRegisterLobbySource,
  assertRegisterLobbyAllowedForProfile,
  tryExtractLobbyPlayers,
} from '../../services/lobby/index.js';
import {
  getLeagueOption,
  resolveLeagueIdFromInteraction,
  respondLeagueAutocomplete,
  withOptionalLeagueOption,
  getGameProfileForLeague,
  assertLeagueLobbyCreateChannel,
} from '../../services/league/index.js';
import {
  EVENT_NOT_ACTIVE_MESSAGE,
  isEventWritable,
  resolveEventContext,
} from '../../services/event/index.js';
import { getGameProfile } from '../../domain/game-profile.js';
import {
  isLeagueWc3statsImportReady,
  resolveLeagueConfig,
} from '../../services/league/league-wc3stats.js';
import { importWc3statsLobby } from '../../services/wc3stats/index.js';
import { loadLeagueWc3statsHeroSlotMap } from '../../services/wc3stats/index.js';
import { sendNewPlayerSuggestPrompts } from '../../discord/interactions/new-player-interactions.js';
import {
  fetchTextAttachment,
  isTextReportAttachment,
} from '../../services/match/match-stats-upload.js';
import { fillLobbyFromWos2Report } from '../../services/match/match-from-wos-report.js';

const log = createLogger('register_lobby');

function categoryIdFromInteraction(interaction: ChatInputCommandInteraction): string | null {
  const channel = interaction.channel;
  if (channel && 'parentId' in channel && typeof channel.parentId === 'string') {
    return channel.parentId;
  }
  return null;
}

function memberRoleIds(interaction: { member: unknown }): string[] {
  const member = interaction.member;

  if (member instanceof GuildMember) {
    return [...member.roles.cache.keys()];
  }

  if (member && typeof member === 'object' && 'roles' in member) {
    const roles = (member as { roles: unknown }).roles;

    if (Array.isArray(roles)) {
      return roles;
    }

    if (roles && typeof roles === 'object' && 'cache' in roles) {
      const cache = (roles as { cache?: Map<string, unknown> }).cache;
      if (cache instanceof Map) {
        return [...cache.keys()];
      }
    }
  }

  return [];
}

export const data = withOptionalLeagueOption(
  new SlashCommandBuilder()
    .setName('register_lobby')
    .setDescription('Register a DBZ match lobby (up to 6v6). Screenshot is optional.')
    .addAttachmentOption((option) =>
      option.setName('print').setDescription('Lobby screenshot (optional)').setRequired(false),
    )
    .addAttachmentOption((option) =>
      option
        .setName('report')
        .setDescription('WOS bot match report .txt (optional, WOS only)')
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('wc3stats_id')
        .setDescription('wc3stats lobby id (optional)')
        .setRequired(false),
    ),
);

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondLeagueAutocomplete(interaction);
}

async function replyWithWos2ReportLobby(
  interaction: ChatInputCommandInteraction,
  input: {
    guildId: string;
    leagueId?: string;
    eventId?: string;
    eventName?: string | null;
    guildConfig: ResolvedGuildConfig;
    reportUrl: string;
    wc3statsReady?: boolean;
    playerClaimEnabled?: boolean;
  },
): Promise<void> {
  const rawText = await fetchTextAttachment(input.reportUrl);
  const filled = await fillLobbyFromWos2Report({
    guildId: input.guildId,
    leagueId: input.leagueId,
    eventId: input.eventId,
    hostDiscordId: interaction.user.id,
    discordChannelId: interaction.channelId!,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: input.guildConfig.matchModRoleId,
    rawText,
    bypassHostLobbyCap: hasMatchModRole({
      actorDiscordId: interaction.user.id,
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: input.guildConfig.matchModRoleId,
    }),
  });

  const ratingPreview =
    filled.match.leagueId != null
      ? await loadLobbyRatingPreview(
          filled.match.leagueId,
          matchPlayersToRatingEntries(filled.match.players),
        )
      : undefined;

  const warningNote = filled.warnings.length > 0 ? `\n_${filled.warnings.join(' · ')}_` : '';

  await interaction.editReply({
    content: `Lobby filled from match report.${warningNote}`,
    embeds: [
      buildMatchLobbyEmbed(filled.matchId, filled.players, {
        canStart: filled.canStart,
        createdAt: filled.createdAt,
        ratingPreview,
        profile: filled.profile,
        eventName: input.eventName,
      }),
    ],
    components: buildLobbyButtons({
      canStart: filled.canStart,
      playerCount: filled.players.length,
      playerClaimEnabled: input.playerClaimEnabled ?? false,
      wc3statsEnabled: input.wc3statsReady ?? false,
      profile: filled.profile,
    }),
  });

  const previewMessage = await interaction.fetchReply();
  await attachDiscordMessage(filled.matchId, previewMessage.id, interaction.channelId!);

  if (filled.match.players.length > 0 && filled.match.leagueId) {
    const suggestions = await collectNewPlayerSuggestionsForPendingCreate({
      leagueId: filled.match.leagueId,
      matchId: filled.matchId,
      players: filled.match.players.map((player) => ({
        playerId: player.playerId,
        username: player.player.username,
      })),
    });
    await sendNewPlayerSuggestPrompts({
      interaction,
      match: {
        id: filled.match.id,
        hostDiscordId: filled.match.hostDiscordId,
        leagueId: filled.match.leagueId,
      },
      suggestions,
      matchModRoleId: input.guildConfig.matchModRoleId,
    });
  }
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  if (!interaction.guildId || !interaction.channelId) {
    await interaction.editReply('This command can only be used in a server channel.');
    return;
  }

  // ── Auth + role check ────────────────────────────────────────────────────────
  let guildConfig: ResolvedGuildConfig | null = null;
  try {
    guildConfig = await resolveGuildConfig(interaction.guildId);
    assertCanCreateMatch({
      memberRoleIds: memberRoleIds(interaction),
      matchCreateRoleId: guildConfig.matchCreateRoleId,
    });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      log.warn({ err: error, userId: interaction.user.id }, 'Match lobby creation forbidden');
      await interaction.editReply(error.message);
      return;
    }
    throw error;
  }

  // ── Resolve Event bind first, else league ──────────────────────────────────
  const eventResolved = await resolveEventContext({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    categoryId: categoryIdFromInteraction(interaction),
  });

  if (eventResolved.ok) {
    if (!isEventWritable(eventResolved.event)) {
      await interaction.editReply(EVENT_NOT_ACTIVE_MESSAGE);
      return;
    }

    const event = eventResolved.event;
    const profile = getGameProfile(event.gameId);
    const printAttachment = interaction.options.getAttachment('print');
    const reportAttachment = interaction.options.getAttachment('report');

    if (printAttachment && reportAttachment) {
      await interaction.editReply(
        'Attach either a screenshot (`print`) or a match report (`report`), not both.',
      );
      return;
    }

    if (reportAttachment) {
      if (
        !isTextReportAttachment({
          contentType: reportAttachment.contentType,
          name: reportAttachment.name,
        })
      ) {
        await interaction.editReply('Please attach a valid WOS bot match report (.txt or .log).');
        return;
      }

      try {
        assertRegisterLobbyAllowedForProfile(profile, {
          hasScreenshot: false,
          hasWc3statsId: false,
          hasReport: true,
        });
      } catch (error) {
        if (error instanceof MatchServiceError) {
          await interaction.editReply(error.message);
          return;
        }
        throw error;
      }

      try {
        await replyWithWos2ReportLobby(interaction, {
          guildId: interaction.guildId,
          eventId: event.id,
          eventName: event.name,
          guildConfig: guildConfig!,
          reportUrl: reportAttachment.url,
        });
      } catch (error) {
        if (error instanceof MatchServiceError) {
          await interaction.editReply(error.message);
          return;
        }
        log.error(
          { err: error, userId: interaction.user.id },
          'Failed to register event lobby from report',
        );
        await interaction.editReply(
          'Could not create the match lobby from the report. Please try again.',
        );
      }
      return;
    }

    if (printAttachment && !isImageAttachment(printAttachment)) {
      await interaction.editReply(
        'Please attach a valid lobby screenshot image (PNG, JPG, WEBP, or GIF).',
      );
      return;
    }

    let players: LobbyPlayer[] = [];
    if (printAttachment) {
      players = await tryExtractLobbyPlayers(printAttachment.url, resolveMimeType(printAttachment));
    }

    try {
      assertRegisterLobbyAllowedForProfile(profile, {
        hasScreenshot: Boolean(printAttachment),
        hasWc3statsId: false,
        hasReport: false,
      });
    } catch (error) {
      if (error instanceof MatchServiceError) {
        await interaction.editReply(error.message);
        return;
      }
      throw error;
    }

    const canStart = canStartLobby(players, profile);

    try {
      const created = await createPendingMatch({
        eventId: event.id,
        hostDiscordId: interaction.user.id,
        discordChannelId: interaction.channelId,
        players,
        lobbyRosterAuthorityAt: printAttachment ? new Date() : undefined,
        bypassHostLobbyCap: hasMatchModRole({
          actorDiscordId: interaction.user.id,
          memberRoleIds: memberRoleIds(interaction),
          matchModRoleId: guildConfig?.matchModRoleId,
        }),
      });

      await interaction.editReply({
        embeds: [
          buildMatchLobbyEmbed(created.matchId, players, {
            canStart,
            createdAt: created.createdAt,
            profile,
            eventName: event.name,
          }),
        ],
        components: buildLobbyButtons({
          canStart,
          playerCount: players.length,
          playerClaimEnabled: false,
          wc3statsEnabled: false,
          profile,
        }),
      });

      const previewMessage = await interaction.fetchReply();
      await attachDiscordMessage(created.matchId, previewMessage.id, interaction.channelId);

      log.info(
        {
          matchId: created.matchId,
          eventId: event.id,
          messageId: previewMessage.id,
          ownerId: interaction.user.id,
          playerCount: players.length,
        },
        'Event match lobby registered',
      );
    } catch (error) {
      if (error instanceof MatchServiceError) {
        await interaction.editReply(error.message);
        return;
      }
      log.error({ err: error, userId: interaction.user.id }, 'Failed to register event lobby');
      await interaction.editReply('Could not create the match lobby. Please try again.');
    }
    return;
  }

  // ── Resolve league (IHL) ─────────────────────────────────────────────────────
  const leagueResolved = await resolveLeagueIdFromInteraction(
    interaction,
    getLeagueOption(interaction),
  );
  if (!leagueResolved.ok) {
    await interaction.editReply(leagueResolved.message);
    return;
  }
  const leagueId = leagueResolved.leagueId;

  try {
    await assertLeagueLobbyCreateChannel(leagueId, interaction.channelId);
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.editReply(error.message);
      return;
    }
    throw error;
  }

  const leagueConfig = await resolveLeagueConfig(leagueId);
  const profile = await getGameProfileForLeague(leagueId);
  const wc3statsReady = isLeagueWc3statsImportReady(leagueConfig);
  const playerClaimEnabled = leagueConfig.lobbyPlayerClaimEnabled;

  // ── Parse options ────────────────────────────────────────────────────────────
  const printAttachment = interaction.options.getAttachment('print');
  const reportAttachment = interaction.options.getAttachment('report');
  let wc3statsId: number | null = null;

  if (printAttachment && reportAttachment) {
    await interaction.editReply(
      'Attach either a screenshot (`print`) or a match report (`report`), not both.',
    );
    return;
  }

  try {
    wc3statsId = parseWc3statsId(interaction.options.getString('wc3stats_id'));
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.editReply(error.message);
      return;
    }
    throw error;
  }

  if (reportAttachment) {
    if (
      !isTextReportAttachment({
        contentType: reportAttachment.contentType,
        name: reportAttachment.name,
      })
    ) {
      await interaction.editReply('Please attach a valid WOS bot match report (.txt or .log).');
      return;
    }

    try {
      assertRegisterLobbyAllowedForProfile(profile, {
        hasScreenshot: false,
        hasWc3statsId: wc3statsId != null,
        hasReport: true,
      });
    } catch (error) {
      if (error instanceof MatchServiceError) {
        await interaction.editReply(error.message);
        return;
      }
      throw error;
    }

    try {
      await replyWithWos2ReportLobby(interaction, {
        guildId: interaction.guildId,
        leagueId,
        guildConfig: guildConfig!,
        reportUrl: reportAttachment.url,
        wc3statsReady,
        playerClaimEnabled,
      });
      log.info(
        {
          userId: interaction.user.id,
          guildId: interaction.guildId,
          leagueId,
        },
        'Match lobby registered from WOS report',
      );
    } catch (error) {
      if (error instanceof MatchServiceError) {
        await interaction.editReply(error.message);
        return;
      }
      log.error(
        { err: error, userId: interaction.user.id },
        'Failed to register lobby from report',
      );
      await interaction.editReply(
        'Could not create the match lobby from the report. Please try again.',
      );
    }
    return;
  }

  try {
    assertRegisterLobbyAllowedForProfile(profile, {
      hasScreenshot: Boolean(printAttachment),
      hasWc3statsId: wc3statsId != null,
      hasReport: false,
    });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.editReply(error.message);
      return;
    }
    throw error;
  }

  log.info(
    {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      hasScreenshot: Boolean(printAttachment),
      wc3statsId,
      wc3statsEnabled: wc3statsReady,
      attachmentName: printAttachment?.name,
      contentType: printAttachment?.contentType,
      size: printAttachment?.size,
    },
    'Register lobby started',
  );

  if (printAttachment && !isImageAttachment(printAttachment)) {
    log.warn(
      {
        userId: interaction.user.id,
        contentType: printAttachment.contentType,
        name: printAttachment.name,
      },
      'Rejected non-image attachment',
    );
    await interaction.editReply(
      'Please attach a valid lobby screenshot image (PNG, JPG, WEBP, or GIF).',
    );
    return;
  }

  const source = resolveRegisterLobbySource({
    printAttachmentUrl: printAttachment?.url,
    reportAttachmentUrl: null,
    printMimeType: printAttachment ? resolveMimeType(printAttachment) : null,
    wc3statsEnabled: wc3statsReady,
    wc3statsId,
  });

  let players: LobbyPlayer[] = [];
  let wc3statsGameId: string | null = null;
  let wc3statsUnavailable = false;

  if (source.kind === 'screenshot') {
    players = await tryExtractLobbyPlayers(source.url, source.mimeType);
  }

  if (wc3statsReady && (source.kind === 'wc3stats' || wc3statsId)) {
    let hostNick: string | null = null;
    try {
      hostNick = await nickForDiscordId(interaction.user.id, profile.gameId);
    } catch (error) {
      if (!(error instanceof MatchServiceError)) {
        throw error;
      }
    }

    const slotMap = await loadLeagueWc3statsHeroSlotMap(leagueId);

    let imported;
    try {
      imported = await importWc3statsLobby({
        wc3statsId,
        hostNick,
        requireNickInLobby: !wc3statsId,
        slotMap,
        mapPattern: leagueConfig.wc3statsMapPattern!,
        mapSha1: leagueConfig.wc3statsMapSha1,
      });
    } catch (error) {
      if (error instanceof MatchServiceError) {
        await interaction.editReply(error.message);
        return;
      }
      throw error;
    }
    if (!imported.ok) {
      if (!allowsEmptyMatchOnWc3statsFailure(imported.code)) {
        await interaction.editReply(imported.message);
        return;
      }
      if (imported.code === 'unavailable') {
        wc3statsUnavailable = true;
      }
      log.warn(
        { code: imported.code, message: imported.message },
        'wc3stats import skipped; creating Discord lobby',
      );
    } else {
      wc3statsGameId = imported.gameId;
      if (source.kind !== 'screenshot') {
        players = imported.roster.usable ? imported.roster.players : [];
      }
    }
  }

  const canStart = canStartLobby(players, profile);

  try {
    const created = await createPendingMatch({
      leagueId,
      hostDiscordId: interaction.user.id,
      discordChannelId: interaction.channelId,
      players,
      wc3statsGameId,
      lobbyRosterAuthorityAt: printAttachment ? new Date() : undefined,
      bypassHostLobbyCap: hasMatchModRole({
        actorDiscordId: interaction.user.id,
        memberRoleIds: memberRoleIds(interaction),
        matchModRoleId: guildConfig?.matchModRoleId,
      }),
    });

    const match = await getMatchById(created.matchId);
    const ratingPreview = match
      ? await loadLobbyRatingPreview(leagueId, matchPlayersToRatingEntries(match.players))
      : undefined;

    await interaction.editReply({
      embeds: [
        buildMatchLobbyEmbed(created.matchId, players, {
          canStart,
          createdAt: created.createdAt,
          ratingPreview,
          wc3statsGameId,
          wc3statsUnavailable,
          wc3statsLinkAvailable: wc3statsReady && !wc3statsGameId,
          profile,
        }),
      ],
      components: buildLobbyButtons({
        canStart,
        playerCount: players.length,
        playerClaimEnabled,
        wc3statsGameId,
        wc3statsEnabled: wc3statsReady,
        profile,
      }),
    });

    const previewMessage = await interaction.fetchReply();

    await attachDiscordMessage(created.matchId, previewMessage.id, interaction.channelId);

    if (match && match.players.length > 0) {
      const suggestions = await collectNewPlayerSuggestionsForPendingCreate({
        leagueId,
        matchId: created.matchId,
        players: match.players.map((player) => ({
          playerId: player.playerId,
          username: player.player.username,
        })),
      });
      await sendNewPlayerSuggestPrompts({
        interaction,
        match: {
          id: match.id,
          hostDiscordId: match.hostDiscordId,
          leagueId: match.leagueId!,
        },
        suggestions,
        matchModRoleId: guildConfig?.matchModRoleId,
      });
    }

    log.info(
      {
        matchId: created.matchId,
        messageId: previewMessage.id,
        ownerId: interaction.user.id,
        playerCount: players.length,
        canStart,
        wc3statsGameId,
      },
      'Match lobby registered',
    );
  } catch (error) {
    if (error instanceof MatchServiceError) {
      log.warn({ err: error, userId: interaction.user.id }, 'Match lobby registration rejected');
      await interaction.editReply(error.message);
      return;
    }

    log.error({ err: error, userId: interaction.user.id }, 'Failed to register match lobby');
    await interaction.editReply('Could not create the match lobby. Please try again.');
  }
}
