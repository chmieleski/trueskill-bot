import { GuildMember, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { syncLobbyDiscordMessage } from '../../services/lobby-actions.js';
import { resolveGuildConfig } from '../../services/guild-config.js';
import { assertCanManageMatch } from '../../services/match-auth.js';
import {
  cancelInProgressMatch,
  completeMatch,
  setQuitters,
} from '../../services/match-report.js';
import {
  findInProgressMatchesByHost,
  getMatchById,
  MatchServiceError,
  type MatchWithPlayers,
} from '../../services/match-service.js';
import type { LobbyRatingPreview } from '../../services/rating-preview.js';

const log = createLogger('match_cmd');

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

function hasMatchModeratorRole(
  interaction: { member: unknown },
  matchModRoleId: string | undefined,
): boolean {
  if (!matchModRoleId) {
    return false;
  }

  return memberRoleIds(interaction).includes(matchModRoleId);
}

export function parseQuitterSlots(slotsRaw: string | null | undefined): number[] {
  const trimmed = slotsRaw?.trim();

  if (!trimmed) {
    return [];
  }

  const slots = new Set<number>();

  for (const token of trimmed.split(',')) {
    const value = token.trim();

    if (!value) {
      continue;
    }

    const slot = Number(value);

    if (!Number.isInteger(slot) || slot < MIN_SLOT || slot > MAX_SLOT) {
      throw new MatchServiceError(
        `Invalid quitter slot "${value}". Slots must be between ${MIN_SLOT} and ${MAX_SLOT}.`,
      );
    }

    slots.add(slot);
  }

  return [...slots].sort((a, b) => a - b);
}

function parseWinner(winner: string): 1 | 2 {
  if (winner === 'A') {
    return 1;
  }

  if (winner === 'B') {
    return 2;
  }

  throw new MatchServiceError('Invalid winning team selection.');
}

async function resolveMatchForCommand(
  interaction: ChatInputCommandInteraction,
  matchId: string | null,
): Promise<MatchWithPlayers> {
  if (!interaction.guildId) {
    throw new MatchServiceError('This command can only be used in a server.');
  }

  const config = await resolveGuildConfig(interaction.guildId);
  const roles = memberRoleIds(interaction);

  if (matchId) {
    const match = await getMatchById(matchId);

    if (!match) {
      throw new MatchServiceError('This match was not found.');
    }

    if (match.status !== 'IN_PROGRESS') {
      throw new MatchServiceError('This match is not in progress.');
    }

    assertCanManageMatch({
      hostDiscordId: match.hostDiscordId,
      actorDiscordId: interaction.user.id,
      memberRoleIds: roles,
      matchModRoleId: config.matchModRoleId,
    });

    return match;
  }

  const matches = await findInProgressMatchesByHost(interaction.user.id);

  if (matches.length === 1) {
    return matches[0]!;
  }

  if (matches.length > 1) {
    throw new MatchServiceError('You have more than one in-progress match. Pass match_id to choose one.');
  }

  if (hasMatchModeratorRole(interaction, config.matchModRoleId)) {
    throw new MatchServiceError('Provide match_id when using the match moderator role.');
  }

  throw new MatchServiceError('You have no in-progress match. Pass match_id to choose one.');
}

async function applyMatchMutation(
  interaction: ChatInputCommandInteraction,
  match: MatchWithPlayers,
  mode: 'started' | 'completed' | 'cancelled',
  replyMessage: string,
  options: { ratingPreview?: LobbyRatingPreview } = {},
): Promise<void> {
  await syncLobbyDiscordMessage(interaction.client, match, mode, options);
  await interaction.editReply({ content: replyMessage });
}

export const data = new SlashCommandBuilder()
  .setName('match')
  .setDescription('Manage an in-progress match')
  .addSubcommand((subcommand) =>
    subcommand
      .setName('quitters')
      .setDescription('Mark players who quit')
      .addStringOption((option) =>
        option
          .setName('slots')
          .setDescription('Comma-separated slots like "1,3,7"')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('In-progress match id (required if you have more than one)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('complete')
      .setDescription('Complete a match and apply ratings')
      .addStringOption((option) =>
        option
          .setName('winner')
          .setDescription('Winning team')
          .setRequired(true)
          .addChoices(
            { name: 'Team A', value: 'A' },
            { name: 'Team B', value: 'B' },
          ),
      )
      .addStringOption((option) =>
        option
          .setName('quitters')
          .setDescription('Comma-separated slots like "1,3,7"')
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('In-progress match id (required if you have more than one)')
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('cancel')
      .setDescription('Cancel an in-progress match')
      .addStringOption((option) =>
        option
          .setName('match_id')
          .setDescription('In-progress match id (required if you have more than one)')
          .setRequired(false),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const subcommand = interaction.options.getSubcommand(true);
  const matchId = interaction.options.getString('match_id');

  log.info(
    {
      userId: interaction.user.id,
      subcommand,
      matchId,
      channelId: interaction.channelId,
    },
    'Match command started',
  );

  try {
    const match = await resolveMatchForCommand(interaction, matchId);

    if (subcommand === 'quitters') {
      const quitterSlots = parseQuitterSlots(interaction.options.getString('slots'));
      await interaction.editReply({ content: 'Saving quitters…' });
      const updated = await setQuitters(match.id, quitterSlots);
      await applyMatchMutation(
        interaction,
        updated,
        'started',
        `Quitters updated in match \`${updated.id}\`.`,
      );
      return;
    }

    if (subcommand === 'complete') {
      const winner = parseWinner(interaction.options.getString('winner', true));
      const quittersRaw = interaction.options.getString('quitters');
      const quitterSlots = quittersRaw === null ? undefined : parseQuitterSlots(quittersRaw);
      await interaction.editReply({
        content: 'Updating ratings and completing the match… This can take a few seconds.',
      });
      const completed = await completeMatch(match.id, winner, quitterSlots);
      await applyMatchMutation(
        interaction,
        completed.match,
        'completed',
        `Match \`${completed.match.id}\` completed. Winner: **Team ${winner === 1 ? 'A' : 'B'}**.`,
        { ratingPreview: completed.ratingPreview },
      );
      return;
    }

    if (subcommand === 'cancel') {
      await interaction.editReply({
        content: 'Cancelling the match… Applying quitter penalties if any are marked.',
      });
      const cancelled = await cancelInProgressMatch(match.id);
      await applyMatchMutation(
        interaction,
        cancelled,
        'cancelled',
        `Match \`${cancelled.id}\` cancelled.`,
      );
      return;
    }

    await interaction.editReply({ content: 'Unknown match subcommand.' });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      log.warn({ err: error, userId: interaction.user.id, subcommand }, 'Match command rejected');
      await interaction.editReply({ content: error.message });
      return;
    }

    log.error({ err: error, userId: interaction.user.id, subcommand }, 'Match command failed');
    await interaction.editReply({
      content: 'Could not update the match. Please try again.',
    });
  }
}
