import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { resolveGuildConfig } from '../../services/guild/index.js';
import {
  addLobbyPlayer,
  addLobbyPlayerFromDiscord,
  attachRecreatedLobbyMessage,
  buildLobbyButtons,
  buildMatchLobbyEmbed,
  cancelLobbyMatch,
  isImageAttachment,
  parseRemapPairs,
  recreateLobbyFromVoidedMatch,
  refreshLobbyFromScreenshot,
  refreshLobbyFromWc3stats,
  remapLobbyPlayers,
  removeLobbyPlayer,
  resolveHostPendingMatch,
  resolveMimeType,
  resolveSwapForm,
  startLobbyMatch,
  swapLobbyPlayers,
} from '../../services/lobby/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import { sendNewPlayerSuggestPrompts } from '../../discord/interactions/new-player-interactions.js';

const log = createLogger('lobby_cmd');

const MIN_SLOT = 1;
const MAX_SLOT = 12;

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

export const data = new SlashCommandBuilder()
  .setName('lobby')
  .setDescription('Manage your pending match lobby')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription('Add a player to your lobby')
      .addIntegerOption((option) =>
        option
          .setName('slot')
          .setDescription('Slot number (1-12)')
          .setRequired(true)
          .setMinValue(MIN_SLOT)
          .setMaxValue(MAX_SLOT),
      )
      .addStringOption((option) =>
        option.setName('nick').setDescription('In-game nick').setRequired(false),
      )
      .addUserOption((option) =>
        option
          .setName('user')
          .setDescription('Linked Discord member (instead of nick)')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('Pending match id (required if you have more than one)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('remove')
      .setDescription('Remove a player from a pending lobby (host or match moderator)')
      .addStringOption((option) =>
        option.setName('nick').setDescription('In-game nick').setRequired(false),
      )
      .addIntegerOption((option) =>
        option
          .setName('slot')
          .setDescription('Slot number (1-12)')
          .setRequired(false)
          .setMinValue(MIN_SLOT)
          .setMaxValue(MAX_SLOT),
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('Pending match id (required if several, or if you are not the host)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('swap')
      .setDescription('Swap or move seats (two slots, or pairs like 1-7,5-Gohan)')
      .addIntegerOption((option) =>
        option
          .setName('slot_a')
          .setDescription('First occupied slot')
          .setRequired(false)
          .setMinValue(MIN_SLOT)
          .setMaxValue(MAX_SLOT),
      )
      .addIntegerOption((option) =>
        option
          .setName('slot_b')
          .setDescription('Second occupied slot')
          .setRequired(false)
          .setMinValue(MIN_SLOT)
          .setMaxValue(MAX_SLOT),
      )
      .addStringOption((option) =>
        option
          .setName('pairs')
          .setDescription('Comma-separated pairs: 1-7, 5-Gohan, Vegeta-4')
          .setRequired(false)
          .setMaxLength(200),
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('Pending match id (required if you have more than one)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('cancel')
      .setDescription('Cancel a pending lobby (host or match moderator)')
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('Pending match id (required if several, or if you are not the host)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('start')
      .setDescription('Start your pending match')
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('Pending match id (required if you have more than one)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('screenshot')
      .setDescription(
        'Replace the lobby roster from a Warcraft lobby screenshot (host or match moderator)',
      )
      .addAttachmentOption((option) =>
        option.setName('print').setDescription('Lobby screenshot').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('Pending match id (required if several, or if you are not the host)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('sync')
      .setDescription('Attach or refresh the live Warcraft lobby from wc3stats')
      .addIntegerOption((option) =>
        option
          .setName('wc3stats_id')
          .setDescription('Game list id (optional if your linked nick is in the lobby)')
          .setRequired(false)
          .setMinValue(1),
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('Pending match id (required if you have more than one)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('recreate')
      .setDescription(
        'Recreate a pending lobby from a voided match roster (mods only; use after /match void)',
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('Voided completed match id to copy the roster from')
          .setRequired(true),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(true);
  const isPublicLobbyPost = subcommand === 'recreate';
  await interaction.deferReply(
    isPublicLobbyPost ? {} : { flags: MessageFlags.Ephemeral },
  );
  const matchId = interaction.options.getString('match_id');
  const hostDiscordId = interaction.user.id;

  log.info(
    { userId: hostDiscordId, subcommand, matchId, channelId: interaction.channelId },
    'Lobby command started',
  );

  try {
    if (subcommand === 'add') {
      const nickRaw = interaction.options.getString('nick')?.trim() || null;
      const user = interaction.options.getUser('user');
      const slot = interaction.options.getInteger('slot', true);

      if (nickRaw && user) {
        throw new MatchServiceError('Provide either a nick or a Discord user, not both.');
      }

      if (!nickRaw && !user) {
        throw new MatchServiceError('Provide a nick or a Discord user.');
      }

      const result = user
        ? await addLobbyPlayerFromDiscord({
            client: interaction.client,
            hostDiscordId,
            matchId,
            discordId: user.id,
            slot,
          })
        : await addLobbyPlayer({
            client: interaction.client,
            hostDiscordId,
            matchId,
            nick: nickRaw!,
            slot,
          });
      const seatedNick = result.players.find((player) => player.slot === slot)?.nick ?? nickRaw;
      await interaction.editReply({
        content: `Added **${seatedNick}** to slot ${slot} in match \`${result.match.id}\`.`,
      });
      const matchModRoleId = interaction.guildId
        ? (await resolveGuildConfig(interaction.guildId)).matchModRoleId
        : undefined;
      await sendNewPlayerSuggestPrompts({
        interaction,
        match: {
          id: result.match.id,
          hostDiscordId: result.match.hostDiscordId,
          leagueId: result.match.leagueId,
        },
        suggestions: result.newPlayerSuggestions ?? [],
        matchModRoleId,
      });
      return;
    }

    if (subcommand === 'remove') {
      const nick = interaction.options.getString('nick');
      const slot = interaction.options.getInteger('slot');
      const matchModRoleId = interaction.guildId
        ? (await resolveGuildConfig(interaction.guildId)).matchModRoleId
        : undefined;
      const result = await removeLobbyPlayer({
        client: interaction.client,
        actorDiscordId: hostDiscordId,
        matchId,
        nick,
        slot,
        memberRoleIds: memberRoleIds(interaction),
        matchModRoleId,
      });
      await interaction.editReply({
        content: `Player removed from match \`${result.match.id}\`.`,
      });
      return;
    }

    if (subcommand === 'swap') {
      const form = resolveSwapForm({
        slotA: interaction.options.getInteger('slot_a'),
        slotB: interaction.options.getInteger('slot_b'),
        pairs: interaction.options.getString('pairs'),
      });

      if (form.kind === 'classic') {
        const result = await swapLobbyPlayers({
          client: interaction.client,
          hostDiscordId,
          matchId,
          slotA: form.slotA,
          slotB: form.slotB,
        });
        await interaction.editReply({
          content: `Swapped slots ${form.slotA} and ${form.slotB} in match \`${result.match.id}\`.`,
        });
        return;
      }

      const result = await remapLobbyPlayers({
        client: interaction.client,
        hostDiscordId,
        matchId,
        pairs: form.pairs,
      });
      const n = parseRemapPairs(form.pairs).length;
      await interaction.editReply({
        content: `Applied ${n} seat change(s) in match \`${result.match.id}\`.`,
      });
      return;
    }

    if (subcommand === 'cancel') {
      const matchModRoleId = interaction.guildId
        ? (await resolveGuildConfig(interaction.guildId)).matchModRoleId
        : undefined;
      const result = await cancelLobbyMatch({
        client: interaction.client,
        actorDiscordId: hostDiscordId,
        matchId,
        memberRoleIds: memberRoleIds(interaction),
        matchModRoleId,
      });
      await interaction.editReply({
        content: `Match \`${result.match.id}\` cancelled.`,
      });
      return;
    }

    if (subcommand === 'start') {
      const result = await startLobbyMatch({
        client: interaction.client,
        hostDiscordId,
        matchId,
      });
      await interaction.editReply({
        content: `Match \`${result.match.id}\` started.`,
      });
      return;
    }

    if (subcommand === 'screenshot') {
      const attachment = interaction.options.getAttachment('print', true);

      if (!isImageAttachment(attachment)) {
        throw new MatchServiceError(
          'Please attach a valid lobby screenshot image (PNG, JPG, WEBP, or GIF).',
        );
      }

      const matchModRoleId = interaction.guildId
        ? (await resolveGuildConfig(interaction.guildId)).matchModRoleId
        : undefined;
      const result = await refreshLobbyFromScreenshot({
        client: interaction.client,
        actorDiscordId: hostDiscordId,
        matchId,
        memberRoleIds: memberRoleIds(interaction),
        matchModRoleId,
        attachmentUrl: attachment.url,
        mimeType: resolveMimeType(attachment),
      });
      await interaction.editReply({ content: result.message });
      await sendNewPlayerSuggestPrompts({
        interaction,
        match: {
          id: result.match.id,
          hostDiscordId: result.match.hostDiscordId,
          leagueId: result.match.leagueId,
        },
        suggestions: result.newPlayerSuggestions ?? [],
        matchModRoleId,
      });
      return;
    }

    if (subcommand === 'sync') {
      const { match } = await resolveHostPendingMatch({ hostDiscordId, matchId });
      const result = await refreshLobbyFromWc3stats({
        client: interaction.client,
        actorDiscordId: hostDiscordId,
        memberRoleIds: [],
        matchId: match.id,
        wc3statsId: interaction.options.getInteger('wc3stats_id'),
        guildId: interaction.guildId,
      });
      await interaction.editReply({ content: result.message });
      const syncModRoleId = interaction.guildId
        ? (await resolveGuildConfig(interaction.guildId)).matchModRoleId
        : undefined;
      await sendNewPlayerSuggestPrompts({
        interaction,
        match: {
          id: result.match.id,
          hostDiscordId: result.match.hostDiscordId,
          leagueId: result.match.leagueId,
        },
        suggestions: result.newPlayerSuggestions ?? [],
        matchModRoleId: syncModRoleId,
      });
      return;
    }

    if (subcommand === 'recreate') {
      if (!interaction.guildId || !interaction.channelId) {
        throw new MatchServiceError('This command can only be used in a server channel.');
      }

      const sourceMatchId = interaction.options.getString('match_id', true);
      const matchModRoleId = (await resolveGuildConfig(interaction.guildId)).matchModRoleId;
      const result = await recreateLobbyFromVoidedMatch({
        actorDiscordId: hostDiscordId,
        memberRoleIds: memberRoleIds(interaction),
        matchModRoleId,
        sourceMatchId,
        discordChannelId: interaction.channelId,
      });

      await interaction.editReply({
        embeds: [
          buildMatchLobbyEmbed(result.matchId, result.players, {
            canStart: result.canStart,
            createdAt: result.createdAt,
            ratingPreview: result.ratingPreview,
            wc3statsGameId: result.wc3statsGameId,
            wc3statsLinkAvailable: result.wc3statsReady && !result.wc3statsGameId,
            profile: result.profile,
          }),
        ],
        components: buildLobbyButtons({
          canStart: result.canStart,
          playerCount: result.players.length,
          playerClaimEnabled: result.playerClaimEnabled,
          wc3statsGameId: result.wc3statsGameId,
          wc3statsEnabled: result.wc3statsReady,
          profile: result.profile,
        }),
      });

      const previewMessage = await interaction.fetchReply();
      await attachRecreatedLobbyMessage(
        result.matchId,
        previewMessage.id,
        interaction.channelId,
      );

      await sendNewPlayerSuggestPrompts({
        interaction,
        match: {
          id: result.matchId,
          hostDiscordId: result.hostDiscordId,
          leagueId: result.leagueId,
        },
        suggestions: result.newPlayerSuggestions,
        matchModRoleId,
      });

      log.info(
        {
          sourceMatchId: result.sourceMatchId,
          matchId: result.matchId,
          actorDiscordId: hostDiscordId,
        },
        'Lobby recreated from voided match',
      );
      return;
    }

    await interaction.editReply({ content: 'Unknown lobby subcommand.' });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      log.warn({ err: error, userId: hostDiscordId, subcommand }, 'Lobby command rejected');
      await interaction.editReply({ content: error.message });
      return;
    }

    log.error({ err: error, userId: hostDiscordId, subcommand }, 'Lobby command failed');
    await interaction.editReply({
      content: 'Could not update the lobby. Please try again.',
    });
  }
}
