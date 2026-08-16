import { Attachment, GuildMember, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { extractLobbyPlayers, type LobbyPlayer } from '../../services/lobby/index.js';
import {
  buildLobbyButtons,
  buildMatchLobbyEmbed,
  canStartLobby,
} from '../../services/lobby/index.js';
import {
  resolveGuildConfig,
  type ResolvedGuildConfig,
} from '../../services/guild/index.js';
import { nickForDiscordId } from '../../services/lobby/index.js';
import { assertCanCreateMatch } from '../../services/match/index.js';
import {
  attachDiscordMessage,
  createPendingMatch,
  getMatchById,
  MatchServiceError,
} from '../../services/match/index.js';
import {
  loadLobbyRatingPreview,
  matchPlayersToRatingEntries,
} from '../../services/rating/index.js';
import {
  allowsEmptyMatchOnWc3statsFailure,
  parseWc3statsId,
  resolveRegisterLobbySource,
  assertRegisterLobbyAllowedForProfile,
} from '../../services/lobby/index.js';
import {
  getLeagueOption,
  resolveLeagueIdFromInteraction,
  respondLeagueAutocomplete,
  withOptionalLeagueOption,
  getGameProfileForLeague,
} from '../../services/league/index.js';
import {
  isLeagueWc3statsImportReady,
  resolveLeagueConfig,
} from '../../services/league/league-wc3stats.js';
import { importWc3statsLobby } from '../../services/wc3stats/index.js';
import { loadLeagueWc3statsHeroSlotMap } from '../../services/wc3stats/index.js';

const log = createLogger('register_lobby');

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

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function isImageAttachment(attachment: Attachment): boolean {
  if (attachment.contentType?.startsWith('image/')) {
    return true;
  }

  const name = attachment.name?.toLowerCase() ?? '';
  const dotIndex = name.lastIndexOf('.');

  if (dotIndex === -1) {
    return false;
  }

  return IMAGE_EXTENSIONS.has(name.slice(dotIndex));
}

function resolveMimeType(attachment: Attachment): string {
  if (attachment.contentType?.startsWith('image/')) {
    return attachment.contentType.split(';')[0]!.trim();
  }

  const name = attachment.name?.toLowerCase() ?? '';

  if (name.endsWith('.png')) {
    return 'image/png';
  }

  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
    return 'image/jpeg';
  }

  if (name.endsWith('.webp')) {
    return 'image/webp';
  }

  if (name.endsWith('.gif')) {
    return 'image/gif';
  }

  return 'image/png';
}

/**
 * Soft OCR: return extracted players when possible, otherwise [].
 * Keep partial lobbies even when both-teams validation fails.
 */
async function tryExtractLobbyPlayers(
  url: string,
  mimeType: string,
): Promise<LobbyPlayer[]> {
  try {
    const players = await extractLobbyPlayers(url, mimeType);
    log.debug({ playerCount: players.length, players }, 'OCR players extracted');
    return players;
  } catch (error) {
    log.warn({ err: error }, 'OCR failed; continuing with empty lobby');
    return [];
  }
}

export const data = withOptionalLeagueOption(
  new SlashCommandBuilder()
    .setName('register_lobby')
    .setDescription('Register a DBZ match lobby (up to 6v6). Screenshot is optional.')
    .addAttachmentOption((option) =>
      option.setName('print').setDescription('Lobby screenshot (optional)').setRequired(false),
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

  // ── Resolve league early (needed for IHL config) ─────────────────────────────
  const leagueResolved = await resolveLeagueIdFromInteraction(
    interaction,
    getLeagueOption(interaction),
  );
  if (!leagueResolved.ok) {
    await interaction.editReply(leagueResolved.message);
    return;
  }
  const leagueId = leagueResolved.leagueId;
  const leagueConfig = await resolveLeagueConfig(leagueId);
  const profile = await getGameProfileForLeague(leagueId);
  const wc3statsReady = isLeagueWc3statsImportReady(leagueConfig);
  const playerClaimEnabled = leagueConfig.lobbyPlayerClaimEnabled;

  // ── Parse options ────────────────────────────────────────────────────────────
  const attachment = interaction.options.getAttachment('print');
  let wc3statsId: number | null = null;

  try {
    wc3statsId = parseWc3statsId(interaction.options.getString('wc3stats_id'));
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.editReply(error.message);
      return;
    }
    throw error;
  }

  try {
    assertRegisterLobbyAllowedForProfile(profile, {
      hasScreenshot: Boolean(attachment),
      hasWc3statsId: wc3statsId != null,
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
      hasScreenshot: Boolean(attachment),
      wc3statsId,
      wc3statsEnabled: wc3statsReady,
      attachmentName: attachment?.name,
      contentType: attachment?.contentType,
      size: attachment?.size,
    },
    'Register lobby started',
  );

  if (attachment && !isImageAttachment(attachment)) {
    log.warn(
      { userId: interaction.user.id, contentType: attachment.contentType, name: attachment.name },
      'Rejected non-image attachment',
    );
    await interaction.editReply('Please attach a valid lobby screenshot image (PNG, JPG, WEBP, or GIF).');
    return;
  }

  const source = resolveRegisterLobbySource({
    attachmentUrl: attachment?.url,
    mimeType: attachment ? resolveMimeType(attachment) : null,
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
      hostNick = await nickForDiscordId(interaction.user.id);
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
