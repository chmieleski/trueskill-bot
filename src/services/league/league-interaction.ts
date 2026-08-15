import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Interaction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandBuilder,
  SlashCommandSubcommandGroupBuilder,
} from 'discord.js';
import { listLeaguesForGuild } from './league.js';
import { resolveLeagueContext, type LeagueResolveResult } from './league-resolve.js';

/** User-facing message when the guild has no leagues. */
export const LEAGUE_RESOLVE_NO_LEAGUES =
  'No league is configured for this server. Ask staff to create one with `/league create`.';

/** User-facing message when multiple leagues exist and context is ambiguous. */
export const LEAGUE_RESOLVE_AMBIGUOUS =
  'This server has multiple leagues. Bind this channel to a league, or pass the `league:` option.';

/** User-facing message when an explicit league option does not exist. */
export const LEAGUE_RESOLVE_INVALID_OPTION =
  'Unknown league. Pick one from the `league:` autocomplete list.';

/** User-facing message when the league option belongs to another guild. */
export const LEAGUE_RESOLVE_NOT_IN_GUILD =
  'That league does not belong to this server.';

/**
 * Map a failed resolve reason to an English user-facing string.
 */
export function leagueResolveFailureMessage(
  reason: Extract<LeagueResolveResult, { ok: false }>['reason'],
): string {
  switch (reason) {
    case 'no_leagues':
      return LEAGUE_RESOLVE_NO_LEAGUES;
    case 'ambiguous':
      return LEAGUE_RESOLVE_AMBIGUOUS;
    case 'invalid_option':
      return LEAGUE_RESOLVE_INVALID_OPTION;
    case 'not_in_guild':
      return LEAGUE_RESOLVE_NOT_IN_GUILD;
    default:
      return LEAGUE_RESOLVE_AMBIGUOUS;
  }
}

/** Discord category id for guild text channels, when available. */
export function getInteractionCategoryId(
  interaction: Pick<Interaction, 'channel'>,
): string | null {
  const channel = interaction.channel;
  if (!channel || !('parentId' in channel)) {
    return null;
  }
  return channel.parentId;
}

type LeagueResolvableInteraction = Pick<
  Interaction,
  'guildId' | 'channelId' | 'channel'
>;

/**
 * Resolve league context from a Discord interaction (channel, category, optional option).
 */
export async function resolveLeagueFromInteraction(
  interaction: LeagueResolvableInteraction,
  leagueIdOption?: string | null,
): Promise<LeagueResolveResult> {
  if (!interaction.guildId) {
    return { ok: false, reason: 'no_leagues' };
  }

  return resolveLeagueContext({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    categoryId: getInteractionCategoryId(interaction),
    leagueIdOption: leagueIdOption ?? null,
  });
}

export type ResolvedLeagueId =
  | { ok: true; leagueId: string }
  | { ok: false; message: string };

/** Convenience wrapper returning league id or a user-facing error message. */
export async function resolveLeagueIdFromInteraction(
  interaction: LeagueResolvableInteraction,
  leagueIdOption?: string | null,
): Promise<ResolvedLeagueId> {
  const result = await resolveLeagueFromInteraction(interaction, leagueIdOption);
  if (result.ok) {
    return { ok: true, leagueId: result.league.id };
  }
  return { ok: false, message: leagueResolveFailureMessage(result.reason) };
}

/** Read optional `league:` slash option from a chat input command. */
export function getLeagueOption(interaction: ChatInputCommandInteraction): string | null {
  return interaction.options.getString('league');
}

/** Attach optional autocomplete `league:` to a slash command builder. */
export function withOptionalLeagueOption(
  builder: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder,
): SlashCommandOptionsOnlyBuilder {
  return builder.addStringOption((option) =>
    option
      .setName('league')
      .setDescription('League (required when this server has multiple leagues)')
      .setRequired(false)
      .setAutocomplete(true),
  );
}

/** Attach optional autocomplete `league:` to a subcommand builder. */
export function withSubcommandLeagueOption(
  builder: SlashCommandSubcommandBuilder,
): SlashCommandSubcommandBuilder {
  return builder.addStringOption((option) =>
    option
      .setName('league')
      .setDescription('League (required when this server has multiple leagues)')
      .setRequired(false)
      .setAutocomplete(true),
  );
}

/** Attach optional autocomplete `league:` to every subcommand in a group. */
export function withGroupLeagueOption(
  group: SlashCommandSubcommandGroupBuilder,
): SlashCommandSubcommandGroupBuilder {
  for (const sub of group.options) {
    if ('addStringOption' in sub) {
      withSubcommandLeagueOption(sub as SlashCommandSubcommandBuilder);
    }
  }
  return group;
}

export async function autocompleteGuildLeagues(
  guildId: string,
  query: string,
): Promise<Array<{ name: string; value: string }>> {
  const leagues = await listLeaguesForGuild(guildId);
  const normalized = query.trim().toLowerCase();
  return leagues
    .filter(
      (league) =>
        normalized.length === 0 ||
        league.name.toLowerCase().includes(normalized) ||
        league.id.toLowerCase().includes(normalized),
    )
    .slice(0, 25)
    .map((league) => ({
      name: league.name.slice(0, 100),
      value: league.id,
    }));
}

/** Respond to `league:` autocomplete when that option is focused. Returns true when handled. */
export async function respondLeagueAutocomplete(
  interaction: AutocompleteInteraction,
): Promise<boolean> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'league') {
    return false;
  }

  if (!interaction.guildId) {
    await interaction.respond([]);
    return true;
  }

  const choices = await autocompleteGuildLeagues(interaction.guildId, focused.value);
  await interaction.respond(choices);
  return true;
}
