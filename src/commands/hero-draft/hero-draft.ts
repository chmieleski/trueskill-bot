import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type TextChannel,
} from 'discord.js';
import { WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { resolveGuildConfig } from '../../services/guild/index.js';
import {
  assertHeroDraftMod,
  cancelHeroDraft,
  findActiveHeroDraftForThread,
  HeroDraftError,
  listCompletableCaptainDrafts,
  loadCompletedCaptainDraft,
  resolveManualTeam,
  startHeroDraft,
  teamFromCaptainDraftTeam,
  type HeroDraftTeam,
} from '../../services/hero-draft/index.js';
import {
  getLeagueOption,
  resolveLeagueIdFromInteraction,
  respondLeagueAutocomplete,
  withSubcommandLeagueOption,
} from '../../services/league/index.js';
import { MatchServiceError } from '../../services/match/index.js';

const log = createLogger('hero_draft_cmd');

async function resolveLeagueIdOrThrow(interaction: ChatInputCommandInteraction): Promise<string> {
  const resolved = await resolveLeagueIdFromInteraction(interaction, getLeagueOption(interaction));
  if (!resolved.ok) {
    throw new HeroDraftError(resolved.message);
  }
  return resolved.leagueId;
}

export const data = new SlashCommandBuilder()
  .setName('hero_draft')
  .setDescription('Run a WOS hero ban/pick draft for predefined teams')
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('start')
        .setDescription('Start a hero draft in a new public thread (mods only)')
        .addIntegerOption((option) =>
          option
            .setName('timer')
            .setDescription('Seconds per ban/pick action (default 30)')
            .setMinValue(5)
            .setMaxValue(300)
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName('captain_draft')
            .setDescription('Completed captain draft to import teams from')
            .setAutocomplete(true)
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName('team1_from')
            .setDescription('Captain key from captain draft for Team 1 (first ban)')
            .setAutocomplete(true)
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName('team2_from')
            .setDescription('Captain key from captain draft for Team 2')
            .setAutocomplete(true)
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName('team1_captain')
            .setDescription('Manual Team 1 captain (@mention or nick)')
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName('team1_roster')
            .setDescription('Manual Team 1 roster (@mentions / nicks)')
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName('team2_captain')
            .setDescription('Manual Team 2 captain (@mention or nick)')
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName('team2_roster')
            .setDescription('Manual Team 2 roster (@mentions / nicks)')
            .setRequired(false),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('cancel')
      .setDescription('Cancel the active hero draft in this thread (mods only)')
      .addStringOption((option) =>
        option
          .setName('draft_id')
          .setDescription('Optional draft id (defaults to this thread)')
          .setRequired(false),
      ),
  );

async function resolveTeam(input: {
  interaction: ChatInputCommandInteraction;
  gameId: string;
  side: 1 | 2;
  captainDraftId: string | null;
  fromCaptainKey: string | null;
  manualCaptain: string | null;
  manualRoster: string | null;
}): Promise<HeroDraftTeam> {
  if (input.fromCaptainKey) {
    if (!input.captainDraftId) {
      throw new HeroDraftError('Provide captain_draft when using team1_from / team2_from.');
    }
    const { state } = await loadCompletedCaptainDraft(input.captainDraftId);
    return teamFromCaptainDraftTeam(state, input.fromCaptainKey, input.side);
  }

  if (input.manualCaptain?.trim()) {
    if (!input.interaction.guild) {
      throw new HeroDraftError('This command can only be used in a server.');
    }
    return resolveManualTeam({
      guild: input.interaction.guild,
      gameId: input.gameId,
      side: input.side,
      captainInput: input.manualCaptain,
      rosterInput: input.manualRoster,
    });
  }

  throw new HeroDraftError(
    `Team ${input.side}: provide team${input.side}_from (with captain_draft) or team${input.side}_captain.`,
  );
}

async function executeStart(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !interaction.channel) {
    await interaction.reply({
      content: 'This command can only be used in a server channel.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (
    interaction.channel.type !== ChannelType.GuildText &&
    interaction.channel.type !== ChannelType.GuildAnnouncement
  ) {
    await interaction.reply({
      content: 'Start a hero draft from a text channel (not inside a thread).',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildConfig = await resolveGuildConfig(interaction.guildId!);
  assertHeroDraftMod(interaction, guildConfig);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const leagueId = await resolveLeagueIdOrThrow(interaction);
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { id: true, gameId: true, name: true },
  });
  if (!league) {
    await interaction.editReply({ content: 'League not found.' });
    return;
  }
  if (league.gameId !== WARCRAFT3_WOS_GAME_ID) {
    await interaction.editReply({
      content: 'Hero draft is only available for Warcraft III WOS leagues.',
    });
    return;
  }

  const captainDraftId = interaction.options.getString('captain_draft');
  const team1 = await resolveTeam({
    interaction,
    gameId: league.gameId,
    side: 1,
    captainDraftId,
    fromCaptainKey: interaction.options.getString('team1_from'),
    manualCaptain: interaction.options.getString('team1_captain'),
    manualRoster: interaction.options.getString('team1_roster'),
  });
  const team2 = await resolveTeam({
    interaction,
    gameId: league.gameId,
    side: 2,
    captainDraftId,
    fromCaptainKey: interaction.options.getString('team2_from'),
    manualCaptain: interaction.options.getString('team2_captain'),
    manualRoster: interaction.options.getString('team2_roster'),
  });

  const timer = interaction.options.getInteger('timer') ?? undefined;
  const draft = await startHeroDraft({
    client: interaction.client,
    guild: interaction.guild,
    parentChannel: interaction.channel as TextChannel,
    hostDiscordId: interaction.user.id,
    leagueId: league.id,
    gameId: league.gameId,
    team1,
    team2,
    timerSeconds: timer,
    sourceCaptainDraftId: captainDraftId,
  });

  await interaction.editReply({
    content: `Hero draft started in <#${draft.threadId}>.`,
  });
}

async function executeCancel(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: 'This command can only be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildConfig = await resolveGuildConfig(interaction.guildId);
  assertHeroDraftMod(interaction, guildConfig);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const explicitId = interaction.options.getString('draft_id');
  let draftId = explicitId;
  if (!draftId) {
    if (!interaction.channelId) {
      await interaction.editReply({ content: 'No channel context for cancel.' });
      return;
    }
    const active = await findActiveHeroDraftForThread(interaction.guildId, interaction.channelId);
    if (!active) {
      await interaction.editReply({ content: 'No active hero draft in this thread.' });
      return;
    }
    draftId = active.id;
  }

  await cancelHeroDraft({ client: interaction.client, draftId });
  await interaction.editReply({ content: 'Hero draft cancelled.' });
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused(true);

  if (focused.name === 'league') {
    await respondLeagueAutocomplete(interaction);
    return;
  }

  if (!interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  if (focused.name === 'captain_draft') {
    const drafts = await listCompletableCaptainDrafts(interaction.guildId);
    const query = focused.value.toLowerCase();
    await interaction.respond(
      drafts
        .filter((draft) => draft.id.toLowerCase().includes(query) || query.length === 0)
        .slice(0, 25)
        .map((draft) => ({
          name: `${draft.id.slice(0, 8)}… (${new Date(draft.updatedAt).toISOString().slice(0, 10)})`.slice(
            0,
            100,
          ),
          value: draft.id,
        })),
    );
    return;
  }

  if (focused.name === 'team1_from' || focused.name === 'team2_from') {
    const captainDraftId = interaction.options.getString('captain_draft');
    if (!captainDraftId) {
      await interaction.respond([]);
      return;
    }
    try {
      const { state } = await loadCompletedCaptainDraft(captainDraftId);
      const query = focused.value.toLowerCase();
      await interaction.respond(
        state.teams
          .filter(
            (team) =>
              team.displayName.toLowerCase().includes(query) ||
              team.captainKey.toLowerCase().includes(query) ||
              query.length === 0,
          )
          .slice(0, 25)
          .map((team) => ({
            name: team.displayName.slice(0, 100),
            value: team.captainKey,
          })),
      );
    } catch {
      await interaction.respond([]);
    }
    return;
  }

  await interaction.respond([]);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  try {
    if (sub === 'start') {
      await executeStart(interaction);
      return;
    }
    if (sub === 'cancel') {
      await executeCancel(interaction);
      return;
    }
    await interaction.reply({
      content: 'Unknown subcommand.',
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    const message =
      error instanceof HeroDraftError || error instanceof MatchServiceError
        ? error.message
        : 'Something went wrong running hero draft.';
    if (!(error instanceof HeroDraftError || error instanceof MatchServiceError)) {
      log.error({ err: error, sub }, 'Hero draft command failed');
    }
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: message });
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  }
}
