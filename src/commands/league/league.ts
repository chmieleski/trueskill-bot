import { ChannelType, GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import { WARCRAFT3_WOS_GAME_ID, WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import { getGameProfile, UnknownGameIdError } from '../../domain/game-profile.js';
import { createLogger } from '../../lib/logger.js';
import { assertCanConfigureBot } from '../../services/guild/index.js';
import { buildRolloverConfirmComponents } from '../../discord/interactions/league-rollover-interactions.js';
import {
  autocompleteActiveGuildLeagues,
  bindDiscordToLeague,
  clearLeagueCrunch,
  createLeague,
  getLeagueById,
  getLeagueOption,
  isLeagueWritable,
  LEAGUE_ARCHIVED_MESSAGE,
  LEAGUE_DECAY_ARCHIVED_MESSAGE,
  LeagueRolloverError,
  listActiveLeaguesForGuild,
  listArchivedLeaguesForGuild,
  listLeaguesForGuild,
  parseSeasonEndDate,
  previewLeagueRollover,
  resolveLeagueIdFromInteraction,
  setLeagueSeasonEndsAt,
  startLeagueCrunch,
  unbindDiscord,
  withSubcommandLeagueOption,
  type League,
  type LeagueBindingKind,
  type LeagueRolloverPreview,
  type LeagueResetMode,
} from '../../services/league/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import { resolveDecaySettings } from '../../services/rating/decay-settings.js';

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

function formatActiveLeagueListLine(league: { id: string; name: string; gameId: string }): string {
  return `• **${league.name}** (\`${league.id}\`) — game \`${league.gameId}\``;
}

function formatArchivedLeagueListLine(league: {
  id: string;
  name: string;
  gameId: string;
  archivedAt: Date | null;
}): string {
  const archivedLabel =
    league.archivedAt === null
      ? 'unknown date'
      : `<t:${Math.floor(league.archivedAt.getTime() / 1000)}:D>`;
  return `• **${league.name}** (\`${league.id}\`) — game \`${league.gameId}\` (archived ${archivedLabel})`;
}

function discordTimestamp(date: Date, style: 'F' | 'D' = 'F'): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

/**
 * Resolve an active (writable) league for season end / crunch staff commands.
 */
async function resolveWritableLeagueForDecay(
  interaction: ChatInputCommandInteraction,
): Promise<{ ok: true; league: League } | { ok: false; message: string }> {
  const resolved = await resolveLeagueIdFromInteraction(interaction, getLeagueOption(interaction));
  if (!resolved.ok) {
    return resolved;
  }

  const league = await getLeagueById(resolved.leagueId);
  if (!league || !isLeagueWritable(league)) {
    return { ok: false, message: LEAGUE_DECAY_ARCHIVED_MESSAGE };
  }

  return { ok: true, league };
}

/** Build the ephemeral Confirm/Cancel preview copy for a league rollover. */
export function buildRolloverPreviewMessage(preview: LeagueRolloverPreview): string {
  const resetLine =
    preview.resetMode === 'soft' && preview.compression !== null
      ? `soft (compression ${preview.compression})`
      : preview.resetMode;

  const lines = [
    `Archive **${preview.sourceLeagueName}** and create **${preview.successorName}**?`,
    `• Reset: ${resetLine}`,
  ];

  if (preview.resetMode === 'continue') {
    lines.push('• Ratings copied unchanged (old league frozen)');
  }

  if (preview.grieferSeasonTax.totalKiTax > 0) {
    lines.push(
      `• Griefer season tax: **${preview.grieferSeasonTax.playerCount}** player(s), **${preview.grieferSeasonTax.totalKiTax}** ki (applied to ending season ratings for rewards)`,
    );
  }

  lines.push(
    `• Players seeded: ${preview.playerCount}`,
    `• Bindings moved: ${preview.bindingCount}`,
    '',
    'This cannot be undone.',
  );

  return lines.join('\n');
}

const DUPLICATE_LEAGUE_NAME_MESSAGE =
  'A league with that name already exists for this game on this server.';

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
          .addChoices(
            { name: 'UDBR (Warcraft III)', value: WARCRAFT3_UDBR_GAME_ID },
            { name: 'WOS', value: WARCRAFT3_WOS_GAME_ID },
          ),
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
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('rollover')
      .setDescription('Archive a league and open a successor season')
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Display name for the new league')
          .setRequired(true)
          .setMaxLength(100),
      )
      .addStringOption((option) =>
        option
          .setName('reset')
          .setDescription('Rating seed mode for the new league')
          .setRequired(true)
          .addChoices(
            { name: 'Continue — copy ki unchanged', value: 'continue' },
            { name: 'Soft — compress toward average', value: 'soft' },
            { name: 'Hard — everyone back to ~1000 ki', value: 'hard' },
          ),
      )
      .addNumberOption((option) =>
        option
          .setName('compression')
          .setDescription('Soft reset pull toward average (0–1, default 0.5)')
          .setMinValue(0)
          .setMaxValue(1)
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('league')
          .setDescription('League to archive (required when multiple active leagues)')
          .setRequired(false)
          .setAutocomplete(true),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('set')
      .setDescription('Set league season settings')
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('season_end')
            .setDescription('Set the season end date (auto crunch starts N days before; default 7)')
            .addStringOption((option) =>
              option
                .setName('date')
                .setDescription('YYYY-MM-DD (UTC end of day) or full date/time')
                .setRequired(true),
            ),
        ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('clear')
      .setDescription('Clear league season settings')
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('season_end')
            .setDescription('Clear the season end date (removes auto crunch from that date)'),
        ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('crunch')
      .setDescription('Start or clear manual end-of-season crunch')
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand.setName('start').setDescription('Start manual crunch now'),
        ),
      )
      .addSubcommand((subcommand) =>
        withSubcommandLeagueOption(
          subcommand
            .setName('clear')
            .setDescription('Clear manual crunch (auto crunch from season end unchanged)'),
        ),
      ),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'league') {
    return;
  }

  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const choices = await autocompleteActiveGuildLeagues(interaction.guildId, focused.value);

  await interaction.respond(choices);
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

  const subcommandGroup = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(true);

  try {
    if (subcommandGroup === 'set' && subcommand === 'season_end') {
      const dateRaw = interaction.options.getString('date', true);
      let seasonEndsAt: Date;
      try {
        seasonEndsAt = parseSeasonEndDate(dateRaw);
      } catch (error) {
        await interaction.reply({
          content: error instanceof Error ? error.message : String(error),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const resolved = await resolveWritableLeagueForDecay(interaction);
      if (!resolved.ok) {
        await interaction.reply({
          content: resolved.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await setLeagueSeasonEndsAt(resolved.league.id, seasonEndsAt);

      const crunchWindowDays = resolveDecaySettings(resolved.league).crunchWindowDays;

      log.info(
        {
          guildId: interaction.guildId,
          leagueId: resolved.league.id,
          seasonEndsAt: seasonEndsAt.toISOString(),
          userId: interaction.user.id,
        },
        'League season end set',
      );

      await interaction.reply({
        content: [
          `Season end for **${resolved.league.name}** set to ${discordTimestamp(seasonEndsAt)}.`,
          `Auto crunch starts ${crunchWindowDays} days before that time.`,
        ].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommandGroup === 'clear' && subcommand === 'season_end') {
      const resolved = await resolveWritableLeagueForDecay(interaction);
      if (!resolved.ok) {
        await interaction.reply({
          content: resolved.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await setLeagueSeasonEndsAt(resolved.league.id, null);

      log.info(
        {
          guildId: interaction.guildId,
          leagueId: resolved.league.id,
          userId: interaction.user.id,
        },
        'League season end cleared',
      );

      await interaction.reply({
        content: `Cleared season end for **${resolved.league.name}**. Auto crunch from that date is removed; manual crunch is unchanged.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommandGroup === 'crunch' && subcommand === 'start') {
      const resolved = await resolveWritableLeagueForDecay(interaction);
      if (!resolved.ok) {
        await interaction.reply({
          content: resolved.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const result = await startLeagueCrunch(resolved.league.id);

      log.info(
        {
          guildId: interaction.guildId,
          leagueId: resolved.league.id,
          alreadyStarted: result.alreadyStarted,
          crunchStartedAt: result.crunchStartedAt.toISOString(),
          userId: interaction.user.id,
        },
        'League crunch start',
      );

      if (result.alreadyStarted) {
        await interaction.reply({
          content: `**${resolved.league.name}** is already in crunch (started ${discordTimestamp(result.crunchStartedAt)}).`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({
        content: `Crunch started for **${resolved.league.name}** at ${discordTimestamp(result.crunchStartedAt)}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommandGroup === 'crunch' && subcommand === 'clear') {
      const resolved = await resolveWritableLeagueForDecay(interaction);
      if (!resolved.ok) {
        await interaction.reply({
          content: resolved.message,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await clearLeagueCrunch(resolved.league.id);

      log.info(
        {
          guildId: interaction.guildId,
          leagueId: resolved.league.id,
          userId: interaction.user.id,
        },
        'League crunch cleared',
      );

      await interaction.reply({
        content: `Cleared manual crunch for **${resolved.league.name}**. If a season end is still set, auto crunch may remain active from that date.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommandGroup) {
      await interaction.reply({
        content: 'Unknown league subcommand.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'create') {
      const gameId = interaction.options.getString('game', true);
      const name = interaction.options.getString('name', true).trim();

      try {
        getGameProfile(gameId);
      } catch (error) {
        if (error instanceof UnknownGameIdError) {
          await interaction.reply({
            content: 'Unknown game.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        throw error;
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
      const [active, archived] = await Promise.all([
        listActiveLeaguesForGuild(interaction.guildId),
        listArchivedLeaguesForGuild(interaction.guildId),
      ]);

      if (active.length === 0 && archived.length === 0) {
        await interaction.reply({
          content: 'No leagues configured for this server. Use `/league create` to add one.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const sections = [
        `Active leagues (${active.length}):`,
        ...(active.length > 0 ? active.map(formatActiveLeagueListLine) : ['• None']),
        '',
        `Archived leagues (read-only) (${archived.length}):`,
        ...(archived.length > 0 ? archived.map(formatArchivedLeagueListLine) : ['• None']),
      ];

      await interaction.reply({
        content: sections.join('\n'),
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

      const league = await getLeagueById(resolved.leagueId);
      if (!league || !isLeagueWritable(league)) {
        await interaction.reply({
          content: LEAGUE_ARCHIVED_MESSAGE,
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
      const boundLeague = leagues.find((entry) => entry.id === resolved.leagueId);
      const leagueLabel = boundLeague ? `**${boundLeague.name}**` : `\`${resolved.leagueId}\``;
      const targetLabel = formatBindTarget(target.id, target.name ?? target.id, kind);
      const kindLabel = kind === 'CATEGORY' ? 'category' : 'channel';

      await interaction.reply({
        content: `Bound ${targetLabel} to league ${leagueLabel} as a ${kindLabel} binding.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'rollover') {
      const successorName = interaction.options.getString('name', true).trim();
      const resetMode = interaction.options.getString('reset', true) as LeagueResetMode;
      const compressionOption = interaction.options.getNumber('compression');

      if (successorName.length === 0) {
        await interaction.reply({
          content: 'League name cannot be empty.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

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

      const sourceLeague = await getLeagueById(resolved.leagueId);
      if (!sourceLeague) {
        await interaction.reply({
          content: 'That league was not found.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const guildLeagues = await listLeaguesForGuild(interaction.guildId);
      if (
        guildLeagues.some(
          (league) => league.gameId === sourceLeague.gameId && league.name === successorName,
        )
      ) {
        await interaction.reply({
          content: DUPLICATE_LEAGUE_NAME_MESSAGE,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      try {
        const preview = await previewLeagueRollover({
          guildId: interaction.guildId,
          sourceLeagueId: resolved.leagueId,
          successorName,
          resetMode,
          compression: compressionOption ?? undefined,
          actorDiscordId: interaction.user.id,
        });

        log.info(
          {
            guildId: interaction.guildId,
            sourceLeagueId: preview.sourceLeagueId,
            draftId: preview.draftId,
            resetMode: preview.resetMode,
            userId: interaction.user.id,
          },
          'League rollover preview created',
        );

        await interaction.reply({
          content: buildRolloverPreviewMessage(preview),
          components: buildRolloverConfirmComponents({
            draftId: preview.draftId,
            actorDiscordId: interaction.user.id,
          }),
          flags: MessageFlags.Ephemeral,
        });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
          await interaction.reply({
            content: DUPLICATE_LEAGUE_NAME_MESSAGE,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (error instanceof LeagueRolloverError) {
          await interaction.reply({
            content: error.message,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        throw error;
      }
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
