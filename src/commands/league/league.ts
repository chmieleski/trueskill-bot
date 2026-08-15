import {
  ChannelType,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import { createLogger } from '../../lib/logger.js';
import { assertCanConfigureBot } from '../../services/guild/index.js';
import {
  bindDiscordToLeague,
  createLeague,
  getLeagueOption,
  listLeaguesForGuild,
  resolveLeagueIdFromInteraction,
  respondLeagueAutocomplete,
  unbindDiscord,
  type LeagueBindingKind,
} from '../../services/league/index.js';
import { MatchServiceError } from '../../services/match/index.js';

const log = createLogger('league_cmd');

const BIND_TARGET_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
  ChannelType.GuildCategory,
] as const;

function memberPermissions(interaction: ChatInputCommandInteraction) {
  const member = interaction.member;

  if (member instanceof GuildMember) {
    return member.permissions;
  }

  if (member && typeof member === 'object' && 'permissions' in member) {
    return (member as { permissions: string }).permissions;
  }

  return null;
}

function inferBindingKind(channelType: ChannelType): LeagueBindingKind {
  return channelType === ChannelType.GuildCategory ? 'CATEGORY' : 'CHANNEL';
}

function formatBindTarget(channelId: string, channelName: string, kind: LeagueBindingKind): string {
  if (kind === 'CATEGORY') {
    return `category **${channelName}** (\`${channelId}\`)`;
  }
  return `<#${channelId}>`;
}

function formatLeagueListLine(league: { id: string; name: string; gameId: string }): string {
  return `• **${league.name}** (\`${league.id}\`) — game \`${league.gameId}\``;
}

export const data = new SlashCommandBuilder()
  .setName('league')
  .setDescription('Create and manage leagues for this server')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('create')
      .setDescription('Create a new league')
      .addStringOption((option) =>
        option
          .setName('game')
          .setDescription('Game for this league')
          .setRequired(true)
          .addChoices({ name: 'UDBR (Warcraft III)', value: WARCRAFT3_UDBR_GAME_ID }),
      )
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Display name for this league')
          .setRequired(true)
          .setMaxLength(100),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('list').setDescription('List leagues configured for this server'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('bind')
      .setDescription('Bind a channel or category to a league')
      .addChannelOption((option) =>
        option
          .setName('target')
          .setDescription('Channel or category to bind to a league')
          .setRequired(true)
          .addChannelTypes(...BIND_TARGET_CHANNEL_TYPES),
      )
      .addStringOption((option) =>
        option
          .setName('league')
          .setDescription('League (required when this server has multiple leagues)')
          .setRequired(false)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('unbind')
      .setDescription('Remove a channel or category binding')
      .addChannelOption((option) =>
        option
          .setName('target')
          .setDescription('Channel or category to unbind')
          .setRequired(true)
          .addChannelTypes(...BIND_TARGET_CHANNEL_TYPES),
      ),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  await respondLeagueAutocomplete(interaction);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    assertCanConfigureBot({
      userId: interaction.user.id,
      memberPermissions: memberPermissions(interaction),
    });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.reply({
        content: error.message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }

  const subcommand = interaction.options.getSubcommand(true);

  try {
    if (subcommand === 'create') {
      const gameId = interaction.options.getString('game', true);
      const name = interaction.options.getString('name', true).trim();

      if (gameId !== WARCRAFT3_UDBR_GAME_ID) {
        await interaction.reply({
          content: 'Unknown game.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (name.length === 0) {
        await interaction.reply({
          content: 'League name cannot be empty.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      try {
        const league = await createLeague({
          guildId: interaction.guildId,
          gameId,
          name,
        });

        log.info(
          {
            guildId: interaction.guildId,
            leagueId: league.id,
            gameId,
            name,
            userId: interaction.user.id,
          },
          'League created',
        );

        await interaction.reply({
          content: `Created league **${league.name}** (\`${league.id}\`) for \`${gameId}\`.`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
          await interaction.reply({
            content: 'A league with that name already exists for this game on this server.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        throw error;
      }
      return;
    }

    if (subcommand === 'list') {
      const leagues = await listLeaguesForGuild(interaction.guildId);

      if (leagues.length === 0) {
        await interaction.reply({
          content: 'No leagues configured for this server. Use `/league create` to add one.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content: [
          `Leagues in this server (${leagues.length}):`,
          ...leagues.map(formatLeagueListLine),
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'bind') {
      const target = interaction.options.getChannel('target', true);
      const kind = inferBindingKind(target.type);

      const resolved = await resolveLeagueIdFromInteraction(
        interaction,
        getLeagueOption(interaction),
      );
      if (!resolved.ok) {
        await interaction.reply({
          content: resolved.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await bindDiscordToLeague({
        leagueId: resolved.leagueId,
        discordId: target.id,
        kind,
      });

      log.info(
        {
          guildId: interaction.guildId,
          leagueId: resolved.leagueId,
          discordId: target.id,
          kind,
          userId: interaction.user.id,
        },
        'League channel binding updated',
      );

      const leagues = await listLeaguesForGuild(interaction.guildId);
      const league = leagues.find((entry) => entry.id === resolved.leagueId);
      const leagueLabel = league ? `**${league.name}**` : `\`${resolved.leagueId}\``;
      const targetLabel = formatBindTarget(target.id, target.name ?? target.id, kind);
      const kindLabel = kind === 'CATEGORY' ? 'category' : 'channel';

      await interaction.reply({
        content: `Bound ${targetLabel} to league ${leagueLabel} as a ${kindLabel} binding.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'unbind') {
      const target = interaction.options.getChannel('target', true);
      const removed = await unbindDiscord(target.id);

      log.info(
        {
          guildId: interaction.guildId,
          discordId: target.id,
          removed,
          userId: interaction.user.id,
        },
        'League channel binding removed',
      );

      const targetLabel = formatBindTarget(
        target.id,
        target.name ?? target.id,
        inferBindingKind(target.type),
      );

      await interaction.reply({
        content: removed
          ? `Removed binding for ${targetLabel}.`
          : `${targetLabel} was not bound to any league.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: 'Unknown league subcommand.',
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.reply({
        content: error.message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }
}
