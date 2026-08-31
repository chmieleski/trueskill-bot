import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type SlashCommandStringOption,
  type TextChannel,
} from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import {
  applyCaptainDraftPick,
  beginCaptainDraft,
  cancelCaptainDraft,
  CaptainDraftError,
  findParticipant,
  loadActiveDraftForChannel,
  modAddPlayer,
  modForcePick,
  modMovePlayer,
  modRemovePlayer,
  modRenameTeam,
  modSwapPlayers,
  modUndoPick,
  parseDraftState,
  publishCaptainDraft,
  renameCaptainTeam,
  resolveParticipantsFromInput,
  setCaptains,
  setMembers,
  startCaptainDraft,
} from '../../services/captain-draft/index.js';
import { assertCaptainDraftMod } from '../../services/captain-draft/draft-auth.js';
import { resolveGuildConfig } from '../../services/guild/index.js';
import {
  getLeagueOption,
  resolveLeagueIdFromInteraction,
  respondLeagueAutocomplete,
  withSubcommandLeagueOption,
} from '../../services/league/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import type { DraftParticipant, DraftState } from '../../services/captain-draft/index.js';

const log = createLogger('captain_draft_cmd');

const PLAYER_AUTOCOMPLETE_LIMIT = 25;
const POOL_ONLY_PLAYER_SUBCOMMANDS = new Set(['pick', 'force_pick']);

function configurePlayerOption(
  option: SlashCommandStringOption,
  name: string,
  description: string,
  required = true,
): SlashCommandStringOption {
  return option
    .setName(name)
    .setDescription(description)
    .setRequired(required)
    .setAutocomplete(true);
}

export const data = new SlashCommandBuilder()
  .setName('captain_draft')
  .setDescription('Run a captain snake draft for tournament team picking')
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('start')
        .setDescription('Create a captain draft in this channel (mods only)'),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('captains')
        .setDescription('Set the captain list during setup (mods only)')
        .addStringOption((option) =>
          option
            .setName('players')
            .setDescription('Captains: @mentions and/or comma-separated nicks')
            .setRequired(true),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    withSubcommandLeagueOption(
      subcommand
        .setName('members')
        .setDescription('Set the member pool during setup (mods only)')
        .addStringOption((option) =>
          option
            .setName('players')
            .setDescription('Members: @mentions and/or comma-separated nicks')
            .setRequired(true),
        ),
    ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('begin')
      .setDescription('Shuffle pick order and post the live draft embed (mods only)'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('pick')
      .setDescription('Pick a player from the pool (current captain only)')
      .addStringOption((option) => configurePlayerOption(option, 'player', 'Player to draft')),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('rename')
      .setDescription('Rename your team after the draft completes (captains only)')
      .addStringOption((option) =>
        option.setName('name').setDescription('New team display name').setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('rename_team')
      .setDescription('Rename any team after the draft completes (mods only)')
      .addStringOption((option) => configurePlayerOption(option, 'team', 'Team to rename'))
      .addStringOption((option) =>
        option.setName('name').setDescription('New team display name').setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('publish')
      .setDescription('Post or refresh team roster embeds (mods only)')
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Target channel (defaults to this channel)')
          .setRequired(false)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('cancel').setDescription('Cancel the channel draft (mods only)'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription('Add a player to the pool or a team (mods only)')
      .addStringOption((option) => configurePlayerOption(option, 'player', 'Player to add'))
      .addStringOption((option) =>
        configurePlayerOption(option, 'team', 'Team roster (required after draft)', false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('remove')
      .setDescription('Remove a player from the pool or a team roster (mods only)')
      .addStringOption((option) => configurePlayerOption(option, 'player', 'Player to remove')),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('swap')
      .setDescription('Swap two drafted players across teams or pool (mods only)')
      .addStringOption((option) => configurePlayerOption(option, 'player_a', 'First player'))
      .addStringOption((option) => configurePlayerOption(option, 'player_b', 'Second player')),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('move')
      .setDescription('Move a drafted player to another team (mods only)')
      .addStringOption((option) => configurePlayerOption(option, 'player', 'Player to move'))
      .addStringOption((option) => configurePlayerOption(option, 'team', 'Destination team')),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName('undo').setDescription('Revert the last snake pick (mods only)'),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('force_pick')
      .setDescription('Assign the current pick for an AFK captain (mods only)')
      .addStringOption((option) => configurePlayerOption(option, 'player', 'Player to draft')),
  );

async function resolveLeagueIdOrThrow(
  interaction: ChatInputCommandInteraction,
): Promise<string | undefined> {
  const resolved = await resolveLeagueIdFromInteraction(interaction, getLeagueOption(interaction));
  if (!resolved.ok) {
    throw new CaptainDraftError(resolved.message);
  }
  return resolved.leagueId;
}

async function resolveGameIdForSetup(
  interaction: ChatInputCommandInteraction,
  draftLeagueId: string | null,
): Promise<string | null> {
  const leagueOpt = getLeagueOption(interaction);
  if (leagueOpt) {
    const resolved = await resolveLeagueIdFromInteraction(interaction, leagueOpt);
    if (!resolved.ok) {
      throw new CaptainDraftError(resolved.message);
    }
    return gameIdForLeague(resolved.leagueId);
  }

  return gameIdForLeague(draftLeagueId);
}

async function gameIdForLeague(leagueId: string | null | undefined): Promise<string | null> {
  if (!leagueId) {
    return null;
  }

  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { gameId: true },
  });
  return league?.gameId ?? null;
}

function requireGuild(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId || !interaction.guild) {
    throw new CaptainDraftError('This command can only be used in a server.');
  }
  if (!interaction.channelId) {
    throw new CaptainDraftError('This command can only be used in a channel.');
  }

  return {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    guild: interaction.guild,
  };
}

async function requireMod(interaction: ChatInputCommandInteraction): Promise<void> {
  const config = await resolveGuildConfig(interaction.guildId!);
  assertCaptainDraftMod(interaction, config);
}

function isSendableGuildTextChannel(channel: unknown): channel is TextChannel {
  return Boolean(
    channel &&
    typeof channel === 'object' &&
    'isTextBased' in channel &&
    typeof (channel as { isTextBased: () => boolean }).isTextBased === 'function' &&
    (channel as { isTextBased: () => boolean }).isTextBased() &&
    'isDMBased' in channel &&
    typeof (channel as { isDMBased: () => boolean }).isDMBased === 'function' &&
    !(channel as { isDMBased: () => boolean }).isDMBased(),
  );
}

function resolvePublishChannel(interaction: ChatInputCommandInteraction): TextChannel {
  const selected = interaction.options.getChannel('channel');
  if (isSendableGuildTextChannel(selected)) {
    return selected;
  }

  if (isSendableGuildTextChannel(interaction.channel)) {
    return interaction.channel;
  }

  throw new CaptainDraftError('Choose a text channel to publish team rosters.');
}

function collectAutocompletePlayers(state: DraftState): DraftParticipant[] {
  const rosterPlayers = state.teams.flatMap((team) =>
    team.roster.filter((player) => player.key !== team.captainKey),
  );

  const byKey = new Map<string, DraftParticipant>();
  for (const player of [...state.memberPool, ...rosterPlayers]) {
    byKey.set(player.key, player);
  }

  return [...byKey.values()];
}

function filterAutocompleteChoices<T extends { name: string }>(entries: T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return entries.slice(0, PLAYER_AUTOCOMPLETE_LIMIT);
  }

  return entries
    .filter((entry) => entry.name.toLowerCase().includes(normalized))
    .slice(0, PLAYER_AUTOCOMPLETE_LIMIT);
}

function teamAutocompleteChoices(state: DraftState, query: string) {
  const choices = state.teams.map((team) => ({
    name: team.displayName.slice(0, 100),
    value: team.captainKey,
  }));
  return filterAutocompleteChoices(choices, query);
}

function playerAutocompleteChoices(state: DraftState, query: string, poolOnly = false) {
  const players = poolOnly ? state.memberPool : collectAutocompletePlayers(state);
  const choices = players.map((player) => ({
    name: player.label.slice(0, 100),
    value: player.key,
  }));
  return filterAutocompleteChoices(choices, query);
}

async function resolvePlayerInput(
  interaction: ChatInputCommandInteraction,
  raw: string,
  leagueId: string | null | undefined,
): Promise<DraftParticipant> {
  const { guildId, channelId } = requireGuild(interaction);
  const draft = await loadActiveDraftForChannel(guildId, channelId);
  const state = parseDraftState(draft);
  const existing = findParticipant(state, raw);
  if (existing) {
    return existing;
  }

  const gameId = await gameIdForLeague(leagueId ?? draft.leagueId);
  const [participant] = await resolveParticipantsFromInput({
    raw,
    gameId,
    guild: interaction.guild!,
  });
  return participant!;
}

function findCaptainKeyForActor(state: DraftState, actorDiscordId: string): string {
  const team = state.teams.find((entry) => {
    const captain = findParticipant(state, entry.captainKey);
    return captain?.discordId === actorDiscordId;
  });

  if (!team) {
    throw new CaptainDraftError('Only the team captain can rename this team.');
  }

  return team.captainKey;
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (await respondLeagueAutocomplete(interaction)) {
    return;
  }

  if (!interaction.guildId || !interaction.channelId) {
    await interaction.respond([]);
    return;
  }

  const draft = await loadActiveDraftForChannel(interaction.guildId, interaction.channelId).catch(
    () => null,
  );
  if (!draft) {
    await interaction.respond([]);
    return;
  }

  const state = parseDraftState(draft);
  const focused = interaction.options.getFocused(true);
  const query = focused.value;
  const subcommand = interaction.options.getSubcommand(false);
  const poolOnly = subcommand ? POOL_ONLY_PLAYER_SUBCOMMANDS.has(subcommand) : false;

  if (focused.name === 'team') {
    await interaction.respond(teamAutocompleteChoices(state, query));
    return;
  }

  if (focused.name === 'player' || focused.name === 'player_a' || focused.name === 'player_b') {
    await interaction.respond(playerAutocompleteChoices(state, query, poolOnly));
    return;
  }

  await interaction.respond([]);
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand(true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const actorDiscordId = interaction.user.id;

  log.info(
    { userId: actorDiscordId, subcommand, channelId: interaction.channelId },
    'Captain draft command started',
  );

  try {
    const { guildId, channelId, guild } = requireGuild(interaction);

    if (subcommand === 'start') {
      await requireMod(interaction);
      const leagueId = await resolveLeagueIdOrThrow(interaction);
      const draft = await startCaptainDraft({
        guildId,
        channelId,
        hostDiscordId: actorDiscordId,
        leagueId,
      });
      await interaction.editReply({
        content: `Captain draft \`${draft.id}\` created. Set captains and members, then run \`/captain_draft begin\`.`,
      });
      return;
    }

    if (subcommand === 'captains') {
      await requireMod(interaction);
      const draft = await loadActiveDraftForChannel(guildId, channelId);
      const gameId = await resolveGameIdForSetup(interaction, draft.leagueId);
      const updated = await setCaptains({
        draftId: draft.id,
        guild,
        raw: interaction.options.getString('players', true),
        gameId,
      });
      const count = parseDraftState(updated).captains.length;
      await interaction.editReply({
        content: `Set **${count}** captain(s) for draft \`${updated.id}\`.`,
      });
      return;
    }

    if (subcommand === 'members') {
      await requireMod(interaction);
      const draft = await loadActiveDraftForChannel(guildId, channelId);
      const gameId = await resolveGameIdForSetup(interaction, draft.leagueId);
      const updated = await setMembers({
        draftId: draft.id,
        guild,
        raw: interaction.options.getString('players', true),
        gameId,
      });
      const count = parseDraftState(updated).memberPool.length;
      await interaction.editReply({
        content: `Set **${count}** member(s) in the pool for draft \`${updated.id}\`.`,
      });
      return;
    }

    if (subcommand === 'begin') {
      await requireMod(interaction);
      const draft = await loadActiveDraftForChannel(guildId, channelId);
      const updated = await beginCaptainDraft({
        client: interaction.client,
        draftId: draft.id,
      });
      await interaction.editReply({
        content: `Captain draft \`${updated.id}\` is live. Captains can pick from the embed or \`/captain_draft pick\`.`,
      });
      return;
    }

    if (subcommand === 'pick') {
      const draft = await loadActiveDraftForChannel(guildId, channelId);
      const playerKey = interaction.options.getString('player', true);
      const updated = await applyCaptainDraftPick({
        client: interaction.client,
        draftId: draft.id,
        actorDiscordId,
        participantKey: playerKey,
      });
      const state = parseDraftState(updated);
      const picked = findParticipant(state, playerKey);
      const label = picked?.label ?? 'Player';
      const statusNote = updated.status === 'COMPLETE' ? ' Draft complete.' : '';
      await interaction.editReply({ content: `Drafted **${label}**.${statusNote}` });
      return;
    }

    if (subcommand === 'rename') {
      const draft = await loadActiveDraftForChannel(guildId, channelId);
      const state = parseDraftState(draft);
      const captainKey = findCaptainKeyForActor(state, actorDiscordId);
      const name = interaction.options.getString('name', true);
      const updated = await renameCaptainTeam({
        client: interaction.client,
        draftId: draft.id,
        actorDiscordId,
        captainKey,
        name,
      });
      await interaction.editReply({
        content: `Renamed your team to **${parseDraftState(updated).teams.find((team) => team.captainKey === captainKey)?.displayName ?? name}**.`,
      });
      return;
    }

    if (subcommand === 'rename_team') {
      await requireMod(interaction);
      const draft = await loadActiveDraftForChannel(guildId, channelId);
      const captainKey = interaction.options.getString('team', true);
      const name = interaction.options.getString('name', true);
      const updated = await modRenameTeam({
        client: interaction.client,
        guildId,
        channelId,
        captainKey,
        name,
      });
      const displayName =
        parseDraftState(updated).teams.find((team) => team.captainKey === captainKey)
          ?.displayName ?? name;
      await interaction.editReply({ content: `Renamed team to **${displayName}**.` });
      return;
    }

    if (subcommand === 'publish') {
      await requireMod(interaction);
      const draft = await loadActiveDraftForChannel(guildId, channelId);
      const channel = resolvePublishChannel(interaction);
      await publishCaptainDraft({
        client: interaction.client,
        draftId: draft.id,
        channel,
      });
      await interaction.editReply({
        content: `Published team rosters to ${channel}.`,
      });
      return;
    }

    if (subcommand === 'cancel') {
      await requireMod(interaction);
      const updated = await cancelCaptainDraft({
        client: interaction.client,
        guildId,
        channelId,
      });
      await interaction.editReply({ content: `Captain draft \`${updated.id}\` cancelled.` });
      return;
    }

    if (subcommand === 'add') {
      await requireMod(interaction);
      const draft = await loadActiveDraftForChannel(guildId, channelId);
      const player = await resolvePlayerInput(
        interaction,
        interaction.options.getString('player', true),
        draft.leagueId,
      );
      const teamCaptainKey = interaction.options.getString('team') ?? undefined;
      const updated = await modAddPlayer({
        client: interaction.client,
        guildId,
        channelId,
        player,
        teamCaptainKey,
      });
      await interaction.editReply({
        content: `Added **${player.label}** to draft \`${updated.id}\`.`,
      });
      return;
    }

    if (subcommand === 'remove') {
      await requireMod(interaction);
      const playerKey = interaction.options.getString('player', true);
      const updated = await modRemovePlayer({
        client: interaction.client,
        guildId,
        channelId,
        participantKey: playerKey,
      });
      await interaction.editReply({ content: `Removed player from draft \`${updated.id}\`.` });
      return;
    }

    if (subcommand === 'swap') {
      await requireMod(interaction);
      const keyA = interaction.options.getString('player_a', true);
      const keyB = interaction.options.getString('player_b', true);
      const updated = await modSwapPlayers({
        client: interaction.client,
        guildId,
        channelId,
        keyA,
        keyB,
      });
      await interaction.editReply({ content: `Swapped players in draft \`${updated.id}\`.` });
      return;
    }

    if (subcommand === 'move') {
      await requireMod(interaction);
      const participantKey = interaction.options.getString('player', true);
      const toCaptainKey = interaction.options.getString('team', true);
      const updated = await modMovePlayer({
        client: interaction.client,
        guildId,
        channelId,
        participantKey,
        toCaptainKey,
      });
      await interaction.editReply({ content: `Moved player in draft \`${updated.id}\`.` });
      return;
    }

    if (subcommand === 'undo') {
      await requireMod(interaction);
      const updated = await modUndoPick({
        client: interaction.client,
        guildId,
        channelId,
      });
      await interaction.editReply({
        content: `Reverted the last pick in draft \`${updated.id}\`.`,
      });
      return;
    }

    if (subcommand === 'force_pick') {
      await requireMod(interaction);
      const playerKey = interaction.options.getString('player', true);
      const updated = await modForcePick({
        client: interaction.client,
        guildId,
        channelId,
        participantKey: playerKey,
      });
      const state = parseDraftState(updated);
      const picked = findParticipant(state, playerKey);
      const statusNote = updated.status === 'COMPLETE' ? ' Draft complete.' : '';
      await interaction.editReply({
        content: `Force-picked **${picked?.label ?? 'player'}**.${statusNote}`,
      });
      return;
    }

    await interaction.editReply({ content: 'Unknown captain draft subcommand.' });
  } catch (error) {
    if (error instanceof CaptainDraftError || error instanceof MatchServiceError) {
      log.warn(
        { err: error, userId: actorDiscordId, subcommand },
        'Captain draft command rejected',
      );
      await interaction.editReply({ content: error.message });
      return;
    }

    log.error({ err: error, userId: actorDiscordId, subcommand }, 'Captain draft command failed');
    await interaction.editReply({
      content: 'Could not update the captain draft. Please try again.',
    });
  }
}
