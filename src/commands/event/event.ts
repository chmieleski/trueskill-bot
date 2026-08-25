import { ChannelType, GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';
import {
  WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID,
  WARCRAFT3_UDBR_GAME_ID,
} from '../../domain/games.js';
import { createLogger } from '../../lib/logger.js';
import { assertCanConfigureBot } from '../../services/guild/index.js';
import {
  bindDiscordToEvent,
  createEvent,
  getEventById,
  listEventsForGuild,
  setEventStatus,
  unbindEventDiscord,
  type Event,
  type EventBindingKind,
} from '../../services/event/index.js';

const log = createLogger('event_cmd');

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

function inferBindingKind(channelType: ChannelType): EventBindingKind {
  return channelType === ChannelType.GuildCategory ? 'CATEGORY' : 'CHANNEL';
}

function channelLabel(target: { id: string; name?: string | null }): string {
  return typeof target.name === 'string' && target.name.length > 0 ? target.name : target.id;
}

function formatBindTarget(channelId: string, channelName: string, kind: EventBindingKind): string {
  if (kind === 'CATEGORY') {
    return `category **${channelName}** (\`${channelId}\`)`;
  }
  return `<#${channelId}>`;
}

function formatEventLine(event: Event): string {
  return `• **${event.name}** (\`${event.id}\`) — game \`${event.gameId}\` — ${event.status}`;
}

export const data = new SlashCommandBuilder()
  .setName('event')
  .setDescription('Manage unrated events (tournaments) for this server')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('create')
      .setDescription('Create an event container for unrated matches')
      .addStringOption((option) =>
        option
          .setName('game')
          .setDescription('Game for this event')
          .setRequired(true)
          .addChoices(
            { name: 'UDBR (Warcraft III)', value: WARCRAFT3_UDBR_GAME_ID },
            { name: 'Anime Choice Arena', value: WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID },
          ),
      )
      .addStringOption((option) =>
        option
          .setName('name')
          .setDescription('Display name for this event')
          .setRequired(true)
          .setMaxLength(100),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('list')
      .setDescription('List events for this server')
      .addStringOption((option) =>
        option
          .setName('game')
          .setDescription('Filter by game')
          .setRequired(false)
          .addChoices(
            { name: 'UDBR (Warcraft III)', value: WARCRAFT3_UDBR_GAME_ID },
            { name: 'Anime Choice Arena', value: WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID },
          ),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('bind')
      .setDescription('Bind a channel or category to a specific event')
      .addChannelOption((option) =>
        option
          .setName('target')
          .setDescription('Channel or category to bind')
          .setRequired(true)
          .addChannelTypes(...BIND_TARGET_CHANNEL_TYPES),
      )
      .addStringOption((option) =>
        option.setName('event').setDescription('Event id').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('unbind')
      .setDescription('Remove an event channel or category binding')
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
      .setName('complete')
      .setDescription('Mark an event as completed (does not cancel open matches)')
      .addStringOption((option) =>
        option.setName('event').setDescription('Event id').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('cancel')
      .setDescription('Mark an event as cancelled (does not cancel open matches)')
      .addStringOption((option) =>
        option.setName('event').setDescription('Event id').setRequired(true).setAutocomplete(true),
      ),
  );

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'event') {
    await interaction.respond([]);
    return;
  }

  const events = await listEventsForGuild(interaction.guildId);
  const q = focused.value.toLowerCase();
  const choices = events
    .filter(
      (event) =>
        event.name.toLowerCase().includes(q) ||
        event.id.toLowerCase().includes(q) ||
        event.gameId.toLowerCase().includes(q),
    )
    .slice(0, 25)
    .map((event) => ({
      name: `${event.name} (${event.status})`.slice(0, 100),
      value: event.id,
    }));

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
    await interaction.reply({
      content: error instanceof Error ? error.message : 'You cannot configure the bot.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand(true);

  try {
    if (subcommand === 'create') {
      const gameId = interaction.options.getString('game', true);
      const name = interaction.options.getString('name', true);
      const event = await createEvent({
        guildId: interaction.guildId,
        gameId,
        name,
      });
      await interaction.reply({
        content: `Created event **${event.name}** (\`${event.id}\`) for game \`${event.gameId}\`. Bind a channel with \`/event bind\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'list') {
      const gameId = interaction.options.getString('game');
      const events = await listEventsForGuild(interaction.guildId, gameId);
      if (events.length === 0) {
        await interaction.reply({
          content: 'No events configured for this server yet.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({
        content: ['**Events**', ...events.map(formatEventLine)].join('\n'),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'bind') {
      const target = interaction.options.getChannel('target', true);
      const eventId = interaction.options.getString('event', true);
      const event = await getEventById(eventId);
      if (!event || event.guildId !== interaction.guildId) {
        await interaction.reply({
          content: 'Event not found in this server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const kind = inferBindingKind(target.type);
      await bindDiscordToEvent({
        eventId: event.id,
        discordId: target.id,
        kind,
      });

      await interaction.reply({
        content: `Bound ${formatBindTarget(target.id, channelLabel(target), kind)} to event **${event.name}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'unbind') {
      const target = interaction.options.getChannel('target', true);
      const removed = await unbindEventDiscord(target.id);
      await interaction.reply({
        content: removed
          ? `Removed event binding from ${formatBindTarget(target.id, channelLabel(target), inferBindingKind(target.type))}.`
          : 'That channel or category was not bound to an event.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'complete' || subcommand === 'cancel') {
      const eventId = interaction.options.getString('event', true);
      const event = await getEventById(eventId);
      if (!event || event.guildId !== interaction.guildId) {
        await interaction.reply({
          content: 'Event not found in this server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const status = subcommand === 'complete' ? 'COMPLETED' : 'CANCELLED';
      const updated = await setEventStatus(event.id, status);
      await interaction.reply({
        content: `Event **${updated.name}** is now **${updated.status}**. Open matches are unchanged — finish or cancel them separately.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content: 'Unknown subcommand.',
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    log.warn({ err: error, subcommand, userId: interaction.user.id }, 'Event command failed');
    const message = error instanceof Error ? error.message : 'Something went wrong.';
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  }
}
