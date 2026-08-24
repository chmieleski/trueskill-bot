import {
  ChannelType,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type NewsChannel,
  type TextChannel,
} from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { resolveGuildConfig } from '../../services/guild/index.js';
import {
  assertCanSyncDocs,
  DocsServiceError,
  syncDiscordDocsToChannel,
  type DiscordDocsKind,
} from '../../services/docs/index.js';

const log = createLogger('sync_docs_cmd');

const CHANNEL_PERMISSION_HINT =
  'I need **View Channel**, **Manage Messages**, and **Send Messages** in that channel to sync docs.';

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

function isPermissionError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (code === 50001 || code === 50013) {
      return true;
    }
  }
  if (error instanceof Error) {
    return /missing access|missing permissions/i.test(error.message);
  }
  return false;
}

function isSendableGuildText(channel: unknown): channel is TextChannel | NewsChannel {
  if (!channel || typeof channel !== 'object') {
    return false;
  }
  const candidate = channel as {
    isTextBased?: () => boolean;
    isDMBased?: () => boolean;
    guild?: unknown;
    send?: unknown;
    type?: number;
  };
  if (typeof candidate.isTextBased !== 'function' || !candidate.isTextBased()) {
    return false;
  }
  if (typeof candidate.isDMBased === 'function' && candidate.isDMBased()) {
    return false;
  }
  if (!candidate.guild || typeof candidate.send !== 'function') {
    return false;
  }
  return (
    candidate.type === ChannelType.GuildText || candidate.type === ChannelType.GuildAnnouncement
  );
}

export const data = new SlashCommandBuilder()
  .setName('sync_docs')
  .setDescription('Wipe a channel and post the bot Discord guides')
  .addSubcommand((sub) =>
    sub
      .setName('public')
      .setDescription('Post public player guides into a channel')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to clear and fill')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('staff')
      .setDescription('Post staff guides into a channel')
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to clear and fill')
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    if (!interaction.guildId) {
      await interaction.editReply({ content: 'This command can only be used in a server.' });
      return;
    }

    const config = await resolveGuildConfig(interaction.guildId);
    assertCanSyncDocs({
      userId: interaction.user.id,
      memberPermissions: memberPermissions(interaction),
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
    });

    const kind = interaction.options.getSubcommand(true) as DiscordDocsKind;
    const optionChannel = interaction.options.getChannel('channel', true);

    let target: TextChannel | NewsChannel | null = isSendableGuildText(optionChannel)
      ? optionChannel
      : null;

    if (!target) {
      const fetched = await interaction.client.channels.fetch(optionChannel.id);
      if (isSendableGuildText(fetched)) {
        target = fetched;
      }
    }

    if (!target) {
      await interaction.editReply({
        content: 'Choose a server text or announcement channel that I can send messages in.',
      });
      return;
    }

    const result = await syncDiscordDocsToChannel({ kind, channel: target });

    await interaction.editReply({
      content: `Cleared #${target.name} and posted ${result.postedCount} ${kind} guide messages.`,
    });
  } catch (error) {
    if (error instanceof DocsServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    if (isPermissionError(error)) {
      await interaction.editReply({ content: CHANNEL_PERMISSION_HINT });
      return;
    }
    log.error({ err: error }, 'sync_docs command failed');
    await interaction.editReply({
      content:
        error instanceof Error ? error.message : 'Something went wrong syncing Discord docs.',
    });
  }
}
