import { GuildMember, MessageFlags } from 'discord.js';
import type { ButtonInteraction, Interaction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { buildLobbyButtons, buildMatchLobbyEmbed } from '../../services/lobby/index.js';
import {
  attachCreatedMatchMessage,
  createMatchFromWc3statsLobby,
} from '../../services/lobby/create-from-wc3stats.js';
import { MatchServiceError } from '../../services/match/index.js';
import { assertLeagueLobbyCreateChannel } from '../../services/league/index.js';
import {
  buildHostPromptDismissEphemeral,
  parseHostPromptCustomId,
} from '../../services/wc3stats/wc3stats-host-prompt.js';
import { rememberHostPromptKey } from '../../services/wc3stats/wc3stats-host-prompt-poller.js';

const log = createLogger('wc3stats-host-prompt-interaction');

const NOT_HOST = 'Only the mentioned Warcraft host can use these buttons.';

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

async function replyEphemeral(interaction: ButtonInteraction, content: string): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function handleOpen(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseHostPromptCustomId(interaction.customId);
  if (!parsed || parsed.action !== 'open') {
    return;
  }

  if (interaction.user.id !== parsed.hostDiscordId) {
    await replyEphemeral(interaction, NOT_HOST);
    return;
  }

  if (!interaction.guildId || !interaction.channelId) {
    await replyEphemeral(interaction, 'This action can only be used in a server channel.');
    return;
  }

  try {
    await assertLeagueLobbyCreateChannel(parsed.leagueId, interaction.channelId);
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await replyEphemeral(interaction, error.message);
      return;
    }
    throw error;
  }

  await interaction.deferUpdate();

  try {
    const created = await createMatchFromWc3statsLobby({
      guildId: interaction.guildId,
      leagueId: parsed.leagueId,
      hostDiscordId: parsed.hostDiscordId,
      discordChannelId: interaction.channelId,
      wc3statsId: parsed.wc3statsId,
      memberRoleIds: memberRoleIds(interaction),
    });

    await interaction.message.edit({
      content: null,
      embeds: [
        buildMatchLobbyEmbed(created.matchId, created.players, {
          canStart: created.canStart,
          createdAt: created.createdAt,
          ratingPreview: created.ratingPreview,
          wc3statsGameId: created.wc3statsGameId,
          wc3statsUnavailable: created.wc3statsUnavailable,
          wc3statsLinkAvailable: created.wc3statsReady && !created.wc3statsGameId,
          profile: created.profile,
        }),
      ],
      components: buildLobbyButtons({
        canStart: created.canStart,
        playerCount: created.players.length,
        playerClaimEnabled: created.playerClaimEnabled,
        wc3statsGameId: created.wc3statsGameId,
        wc3statsEnabled: created.wc3statsReady,
        profile: created.profile,
      }),
    });

    await attachCreatedMatchMessage(created.matchId, interaction.message.id, interaction.channelId);
    rememberHostPromptKey(parsed.leagueId, parsed.wc3statsId);

    log.info(
      {
        matchId: created.matchId,
        leagueId: parsed.leagueId,
        wc3statsId: parsed.wc3statsId,
        hostDiscordId: parsed.hostDiscordId,
      },
      'Opened Discord lobby from wc3stats host prompt',
    );
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await replyEphemeral(interaction, error.message);
      return;
    }
    throw error;
  }
}

async function handleDismiss(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseHostPromptCustomId(interaction.customId);
  if (!parsed || parsed.action !== 'dismiss') {
    return;
  }

  if (interaction.user.id !== parsed.hostDiscordId) {
    await replyEphemeral(interaction, NOT_HOST);
    return;
  }

  await interaction.reply({
    content: buildHostPromptDismissEphemeral(),
    flags: MessageFlags.Ephemeral,
  });
  await interaction.message.delete();
  rememberHostPromptKey(parsed.leagueId, parsed.wc3statsId);

  log.info(
    {
      leagueId: parsed.leagueId,
      wc3statsId: parsed.wc3statsId,
      hostDiscordId: parsed.hostDiscordId,
    },
    'Dismissed wc3stats host lobby prompt',
  );
}

/**
 * Handle host-lobby prompt buttons. Returns true when the interaction was claimed.
 */
export async function handleWc3statsHostPromptInteraction(
  interaction: Interaction,
): Promise<boolean> {
  if (!interaction.isButton() || !interaction.customId.startsWith('host_prompt:')) {
    return false;
  }

  const parsed = parseHostPromptCustomId(interaction.customId);
  if (!parsed) {
    return false;
  }

  if (parsed.action === 'open') {
    await handleOpen(interaction);
    return true;
  }

  if (parsed.action === 'dismiss') {
    await handleDismiss(interaction);
    return true;
  }

  return false;
}
