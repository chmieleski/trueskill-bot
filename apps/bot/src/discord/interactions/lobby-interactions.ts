import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type {
  ButtonInteraction,
  Interaction,
  MessageComponentInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { sendReplacingEphemeral, touchEphemeralSession } from '../../lib/ephemeral-reply.js';
import { deletePreviousEphemeral, rememberEphemeral } from '../../lib/ephemeral-session.js';
import type { LobbyPlayer } from '../../services/lobby/index.js';
import {
  addPlayer,
  applyRosterUpdateForMessage,
  assertLobbyPlayerClaimEnabled,
  claimLobbySlot,
  editPlayerNick,
  leaveLobbySlot,
  movePlayer,
  nextEmptySlotOnTeam,
  cancelLobbyMatch,
  refreshLobbyFromWc3stats,
  removePlayer,
  resolvePendingMatchByMessageId,
  shuffleLobbyRoster,
  startLobbyMatchByMessageId,
  syncLobbyDiscordMessage,
  toggleLobbySlotLock,
} from '../../services/lobby/index.js';
import { claimSlotSelectOptions, LOBBY_CUSTOM_IDS } from '../../services/lobby/index.js';
import { loadHeroCatalog } from '../../services/guild/index.js';
import { nickForDiscordId } from '../../services/lobby/index.js';
import { resolveGuildConfig } from '../../services/guild/index.js';
import {
  assertCanManageMatch,
  getGameProfileForMatch,
  MatchServiceError,
  requireLeagueId,
} from '../../services/match/index.js';
import { teamDisplayName, teamDisplayNameForSlot } from '../../services/guild/index.js';
import {
  invalidSlotMessage,
  teamForSlot,
  type GameProfile,
  type TeamId,
} from '../../domain/game-profile.js';
import type { LobbyActionResult } from '../../services/lobby/index.js';
import { sendNewPlayerSuggestPrompts } from './new-player-interactions.js';
import { fillLobbyFromWos2Report } from '../../services/match/match-from-wos-report.js';
import { collectNewPlayerSuggestionsForPendingCreate } from '../../services/rating/index.js';

const log = createLogger('lobby');

type ComponentRow = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;

const UPDATED_MESSAGE = 'Lobby updated.';

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

function parseCustomId(customId: string): string[] {
  return customId.split(':');
}

function playerSelectOptions(players: LobbyPlayer[]) {
  return [...players]
    .sort((a, b) => a.slot - b.slot)
    .map((player) => ({
      label: `[Slot ${player.slot}] ${player.nick}`.slice(0, 100),
      value: String(player.slot),
    }));
}

function emptySlotSelectOptions(players: LobbyPlayer[], profile: GameProfile) {
  const occupied = new Set(players.map((player) => player.slot));
  const options = [];

  for (let slot = 1; slot <= profile.slotCount; slot += 1) {
    if (occupied.has(slot)) {
      continue;
    }

    const team = teamDisplayNameForSlot(slot, profile);
    options.push({
      label: `Slot ${slot} (${team})`,
      value: String(slot),
    });
  }

  return options;
}

/** Destinations for Change Slot: empty slots (move) and occupied slots (swap). */
function destinationSlotSelectOptions(
  players: LobbyPlayer[],
  fromSlot: number,
  profile: GameProfile,
) {
  if (profile.heroBinding === 'optional_in_game') {
    return teamBasedDestinationOptions(players, fromSlot, profile);
  }

  const bySlot = new Map(players.map((player) => [player.slot, player]));
  const options = [];

  for (let slot = 1; slot <= profile.slotCount; slot += 1) {
    if (slot === fromSlot) {
      continue;
    }

    const team = teamDisplayNameForSlot(slot, profile);
    const occupant = bySlot.get(slot);

    if (occupant) {
      options.push({
        label: `Swap → Slot ${slot} (${occupant.nick})`.slice(0, 100),
        description: team,
        value: String(slot),
      });
    } else {
      options.push({
        label: `Move → Slot ${slot} (empty)`,
        description: team,
        value: String(slot),
      });
    }
  }

  return options;
}

/**
 * WOS-style destinations: move to other team (next empty seat) or swap with a nick.
 */
function teamBasedDestinationOptions(
  players: LobbyPlayer[],
  fromSlot: number,
  profile: GameProfile,
) {
  const options: { label: string; description?: string; value: string }[] = [];
  const fromTeam = teamForSlot(profile, fromSlot);
  const occupied = new Set(players.map((player) => player.slot));

  for (const team of [1, 2] as const) {
    if (team === fromTeam) {
      continue;
    }
    const hasEmpty = Array.from({ length: profile.slotCount }, (_, i) => i + 1).some(
      (slot) => teamForSlot(profile, slot) === team && !occupied.has(slot),
    );
    if (!hasEmpty) {
      continue;
    }
    options.push({
      label: `Move → ${teamDisplayName(team, profile)}`,
      description: 'Empty seat',
      value: `team:${team}`,
    });
  }

  for (const other of players) {
    if (other.slot === fromSlot) {
      continue;
    }
    options.push({
      label: `Swap → ${other.nick}`.slice(0, 100),
      description: teamDisplayNameForSlot(other.slot, profile),
      value: `slot:${other.slot}`,
    });
  }

  return options;
}

/** Resolve move/swap destination custom_id value to a target slot. */
function resolveDestinationSlot(
  value: string,
  players: LobbyPlayer[],
  profile: GameProfile,
): number {
  if (value.startsWith('team:')) {
    const team = Number(value.slice('team:'.length));
    if (team !== 1 && team !== 2) {
      throw new MatchServiceError('Invalid team destination.');
    }
    return nextEmptySlotOnTeam(players, profile, team as TeamId);
  }

  if (value.startsWith('slot:')) {
    return Number(value.slice('slot:'.length));
  }

  return Number(value);
}

async function replyEphemeral(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  content: string,
  components: ComponentRow[] = [],
): Promise<void> {
  await sendReplacingEphemeral(interaction, { content, components });
}

async function updateEphemeral(
  interaction: MessageComponentInteraction,
  content: string,
  components: ComponentRow[] = [],
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content, components });
    touchEphemeralSession(interaction);
    return;
  }

  await interaction.update({ content, components });
  touchEphemeralSession(interaction);
}

function buildLobbyCancelConfirmRow(matchId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`lobby:cancel:ok:${matchId}`)
      .setLabel('Cancel Lobby')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`lobby:cancel:no:${matchId}`)
      .setLabel('Keep Lobby')
      .setStyle(ButtonStyle.Secondary),
  );
}

async function handleCancelEntry(interaction: ButtonInteraction): Promise<void> {
  const result = await requirePendingMatch(interaction.message.id);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  if (!interaction.guildId) {
    await replyEphemeral(interaction, 'This action can only be used in a server.');
    return;
  }

  try {
    const config = await resolveGuildConfig(interaction.guildId);
    assertCanManageMatch({
      hostDiscordId: result.match.hostDiscordId,
      actorDiscordId: interaction.user.id,
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
    });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await replyEphemeral(interaction, error.message);
      return;
    }
    throw error;
  }

  await replyEphemeral(interaction, `Cancel lobby \`${result.match.id}\`?`, [
    buildLobbyCancelConfirmRow(result.match.id),
  ]);
}

async function handleCancelConfirm(interaction: ButtonInteraction, matchId: string): Promise<void> {
  if (!interaction.guildId) {
    await updateEphemeral(interaction, 'This action can only be used in a server.');
    return;
  }

  try {
    const config = await resolveGuildConfig(interaction.guildId);
    const cancelled = await cancelLobbyMatch({
      client: interaction.client,
      actorDiscordId: interaction.user.id,
      matchId,
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
    });
    await updateEphemeral(interaction, `Match \`${cancelled.match.id}\` cancelled.`);
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await updateEphemeral(interaction, error.message);
      return;
    }
    throw error;
  }
}

async function handleCancelKeep(interaction: ButtonInteraction, matchId: string): Promise<void> {
  await updateEphemeral(interaction, `Match \`${matchId}\` was not cancelled.`);
}

/**
 * Host or match mod gate for PENDING lobby buttons (same as Cancel).
 */
async function assertManagePendingOrReply(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  match: { hostDiscordId: string },
): Promise<boolean> {
  const reply = async (content: string) => {
    if (interaction.isStringSelectMenu() || interaction.replied || interaction.deferred) {
      await updateEphemeral(interaction, content);
    } else {
      await replyEphemeral(interaction, content);
    }
  };

  if (!interaction.guildId) {
    await reply('This action can only be used in a server.');
    return false;
  }

  try {
    const config = await resolveGuildConfig(interaction.guildId);
    assertCanManageMatch({
      hostDiscordId: match.hostDiscordId,
      actorDiscordId: interaction.user.id,
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
    });
    return true;
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await reply(error.message);
      return false;
    }
    throw error;
  }
}

async function handleLockToggleEntry(interaction: ButtonInteraction): Promise<void> {
  const messageId = interaction.message.id;
  const result = await requirePendingMatch(messageId);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  if (!(await assertManagePendingOrReply(interaction, result.match))) {
    return;
  }

  const options = playerSelectOptions(result.players);
  if (options.length === 0) {
    await replyEphemeral(interaction, 'No players to lock or unlock.');
    return;
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`lobby:select:lock_slot:${messageId}`)
      .setPlaceholder('Select a player to lock or unlock')
      .addOptions(options),
  );

  await replyEphemeral(interaction, 'Select a player to lock or unlock their seat:', [row]);
}

async function handleSelectLockSlot(
  interaction: StringSelectMenuInteraction,
  messageId: string,
): Promise<void> {
  const slot = Number(interaction.values[0]);
  if (!Number.isInteger(slot)) {
    await updateEphemeral(interaction, 'Invalid slot.');
    return;
  }

  const pending = await requirePendingMatch(messageId);
  if ('error' in pending) {
    await updateEphemeral(interaction, pending.error);
    return;
  }

  if (!(await assertManagePendingOrReply(interaction, pending.match))) {
    return;
  }

  if (!interaction.guildId) {
    return;
  }

  try {
    const config = await resolveGuildConfig(interaction.guildId);
    const result = await toggleLobbySlotLock({
      client: interaction.client,
      actorDiscordId: interaction.user.id,
      matchId: pending.match.id,
      slot,
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
    });
    const locked = result.players.find((player) => player.slot === slot)?.locked === true;
    await updateEphemeral(
      interaction,
      locked
        ? `Locked slot ${slot} in match \`${result.match.id}\`.`
        : `Unlocked slot ${slot} in match \`${result.match.id}\`.`,
    );
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await updateEphemeral(interaction, error.message);
      return;
    }
    throw error;
  }
}

async function handleShuffleEntry(interaction: ButtonInteraction): Promise<void> {
  const messageId = interaction.message.id;
  const result = await requirePendingMatch(messageId);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  if (!(await assertManagePendingOrReply(interaction, result.match))) {
    return;
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`lobby:select:shuffle_scope:${messageId}`)
      .setPlaceholder('Choose shuffle scope')
      .addOptions(
        { label: 'Within teams', value: 'team', description: 'Keep players on their current team' },
        { label: 'Whole lobby', value: 'all', description: 'Players may switch teams' },
      ),
  );

  await replyEphemeral(interaction, 'Shuffle unlocked seats:', [row]);
}

async function handleSelectShuffleScope(
  interaction: StringSelectMenuInteraction,
  messageId: string,
): Promise<void> {
  const scopeRaw = interaction.values[0];
  const scope = scopeRaw === 'all' ? 'all' : 'team';

  const pending = await requirePendingMatch(messageId);
  if ('error' in pending) {
    await updateEphemeral(interaction, pending.error);
    return;
  }

  if (!(await assertManagePendingOrReply(interaction, pending.match))) {
    return;
  }

  if (!interaction.guildId) {
    return;
  }

  try {
    const config = await resolveGuildConfig(interaction.guildId);
    const result = await shuffleLobbyRoster({
      client: interaction.client,
      actorDiscordId: interaction.user.id,
      matchId: pending.match.id,
      scope,
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
    });
    await updateEphemeral(
      interaction,
      `Shuffled unlocked seats (${scope === 'all' ? 'whole lobby' : 'within teams'}) in match \`${result.match.id}\`.`,
    );
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await updateEphemeral(interaction, error.message);
      return;
    }
    throw error;
  }
}

async function requirePendingMatch(messageId: string) {
  try {
    return await resolvePendingMatchByMessageId({ messageId });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      return { error: error.message };
    }

    throw error;
  }
}

async function applyPlayersUpdate(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  messageId: string,
  nextPlayers: LobbyPlayer[],
): Promise<LobbyActionResult | null> {
  try {
    const result = await applyRosterUpdateForMessage({
      client: interaction.client,
      messageId,
      nextPlayers,
    });
    log.debug({ messageId, playerCount: nextPlayers.length }, 'Lobby message refreshed');
    return result;
  } catch (error) {
    if (error instanceof MatchServiceError) {
      log.warn(
        { err: error, messageId, userId: interaction.user.id },
        'Lobby roster update rejected',
      );
      await replyEphemeral(interaction, error.message);
      return null;
    }

    log.error({ err: error, messageId }, 'Failed to update lobby roster');
    await replyEphemeral(interaction, 'Could not update the lobby. Please try again.');
    return null;
  }
}

async function maybeSendNewPlayerSuggests(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  result: LobbyActionResult,
  guildId: string | null,
): Promise<void> {
  const suggestions = result.newPlayerSuggestions;
  if (!suggestions?.length) {
    return;
  }

  const matchModRoleId = guildId ? (await resolveGuildConfig(guildId)).matchModRoleId : undefined;

  await sendNewPlayerSuggestPrompts({
    interaction,
    match: {
      id: result.match.id,
      hostDiscordId: result.match.hostDiscordId,
      leagueId: result.match.leagueId,
    },
    suggestions,
    matchModRoleId,
  });
}

async function handleStart(interaction: ButtonInteraction): Promise<void> {
  const messageId = interaction.message.id;
  const userId = interaction.user.id;
  const result = await requirePendingMatch(messageId);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  await interaction.deferUpdate();

  try {
    const started = await startLobbyMatchByMessageId({
      client: interaction.client,
      messageId,
    });

    log.info(
      {
        messageId,
        userId,
        matchId: started.match.id,
        playerCount: started.players.length,
      },
      'Match started from lobby',
    );

    await replyEphemeral(interaction, `Match \`${started.match.id}\` started.`);
  } catch (error) {
    if (error instanceof MatchServiceError) {
      log.warn({ messageId, userId, err: error }, 'Start match rejected');
      await replyEphemeral(interaction, error.message);
      return;
    }

    log.error({ messageId, userId, err: error }, 'Failed to start match');
    await replyEphemeral(interaction, 'Failed to start the match. Please try again.');
  }
}

async function handleEditNick(interaction: ButtonInteraction): Promise<void> {
  const messageId = interaction.message.id;
  const result = await requirePendingMatch(messageId);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const options = playerSelectOptions(result.players);

  if (options.length === 0) {
    await replyEphemeral(interaction, 'No players to edit.');
    return;
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`lobby:select:edit_nick:${messageId}`)
      .setPlaceholder('Select a player to edit')
      .addOptions(options),
  );

  await replyEphemeral(interaction, 'Select a player to edit their nick:', [row]);
}

async function handleMove(interaction: ButtonInteraction): Promise<void> {
  const messageId = interaction.message.id;
  const result = await requirePendingMatch(messageId);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const options = playerSelectOptions(result.players);

  if (options.length === 0) {
    await replyEphemeral(interaction, 'No players to move.');
    return;
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`lobby:select:move_player:${messageId}`)
      .setPlaceholder('Select a player to move or swap')
      .addOptions(options),
  );

  await replyEphemeral(
    interaction,
    'Select a player to change their slot (empty = move, occupied = swap):',
    [row],
  );
}

async function handleRemove(interaction: ButtonInteraction): Promise<void> {
  const messageId = interaction.message.id;
  const result = await requirePendingMatch(messageId);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const options = playerSelectOptions(result.players);

  if (options.length === 0) {
    await replyEphemeral(interaction, 'No players to remove.');
    return;
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`lobby:select:remove:${messageId}`)
      .setPlaceholder('Select a player to remove')
      .addOptions(options),
  );

  await replyEphemeral(interaction, 'Select a player to remove:', [row]);
}

async function handleAdd(interaction: ButtonInteraction): Promise<void> {
  const messageId = interaction.message.id;
  const result = await requirePendingMatch(messageId);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const profile = await getGameProfileForMatch(result.match);
  if (emptySlotSelectOptions(result.players, profile).length === 0) {
    await replyEphemeral(interaction, 'No empty slots available. Remove a player first.');
    return;
  }

  if (profile.heroBinding === 'optional_in_game') {
    const teamOptions = addTeamSelectOptions(result.players, profile);
    if (teamOptions.length === 0) {
      await replyEphemeral(interaction, 'No empty seats available. Remove a player first.');
      return;
    }

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`lobby:select:add_team:${messageId}`)
        .setPlaceholder('Select a team')
        .addOptions(teamOptions),
    );
    await replyEphemeral(interaction, 'Which team should this player join?', [row]);
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`lobby:modal:add:${messageId}`)
    .setTitle('Add Player');

  const nickInput = new TextInputBuilder()
    .setCustomId('nick')
    .setLabel('In-game nick')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32);

  const slotInput = new TextInputBuilder()
    .setCustomId('slot')
    .setLabel(`Slot number (1-${profile.slotCount})`)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(2);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nickInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(slotInput),
  );

  await interaction.showModal(modal);
}

/** Teams with at least one empty seat (WOS add dropdown). */
function addTeamSelectOptions(players: LobbyPlayer[], profile: GameProfile) {
  const occupied = new Set(players.map((player) => player.slot));
  const options: { label: string; description: string; value: string }[] = [];

  for (const team of [1, 2] as const) {
    let empty = 0;
    for (let slot = 1; slot <= profile.slotCount; slot += 1) {
      if (teamForSlot(profile, slot) === team && !occupied.has(slot)) {
        empty += 1;
      }
    }
    if (empty === 0) {
      continue;
    }
    options.push({
      label: teamDisplayName(team, profile),
      description: empty === 1 ? '1 empty seat' : `${empty} empty seats`,
      value: String(team),
    });
  }

  return options;
}

async function handleSelectAddTeam(
  interaction: StringSelectMenuInteraction,
  messageId: string,
): Promise<void> {
  const result = await requirePendingMatch(messageId);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const teamRaw = interaction.values[0]!;
  const team = Number(teamRaw);
  if (team !== 1 && team !== 2) {
    await replyEphemeral(interaction, 'Invalid team.');
    return;
  }

  const profile = await getGameProfileForMatch(result.match);
  try {
    nextEmptySlotOnTeam(result.players, profile, team as TeamId);
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await replyEphemeral(interaction, error.message);
      return;
    }
    throw error;
  }

  const modal = new ModalBuilder()
    .setCustomId(`lobby:modal:add:${messageId}:${team}`)
    .setTitle(`Add Player — ${teamDisplayName(team as TeamId, profile)}`);

  const nickInput = new TextInputBuilder()
    .setCustomId('nick')
    .setLabel('In-game nick')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(nickInput));

  await interaction.showModal(modal);
}

function requireGuildId(interaction: MessageComponentInteraction): string | null {
  return interaction.guildId;
}

async function handleClaim(interaction: ButtonInteraction): Promise<void> {
  const guildId = requireGuildId(interaction);

  if (!guildId) {
    await replyEphemeral(interaction, 'This command can only be used in a server.');
    return;
  }

  const messageId = interaction.message.id;
  const result = await requirePendingMatch(messageId);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  let profile: GameProfile;
  try {
    await assertLobbyPlayerClaimEnabled(requireLeagueId(result.match));
    profile = await getGameProfileForMatch(result.match);
    const nick = await nickForDiscordId(interaction.user.id, profile.gameId);
    const existing = result.players.find((player) => player.nick === nick);

    if (existing) {
      await replyEphemeral(interaction, `You are already in slot ${existing.slot}. Leave first.`);
      return;
    }
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await replyEphemeral(interaction, error.message);
      return;
    }

    throw error;
  }

  const catalog = await loadHeroCatalog();
  const heroNameById = new Map(catalog.map((hero) => [hero.id, hero.name]));
  const options = claimSlotSelectOptions(
    result.players,
    (slot) => heroNameById.get(slot) ?? `Hero ${slot}`,
    profile,
  );

  if (options.length === 0) {
    await replyEphemeral(interaction, 'No empty slots available.');
    return;
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`lobby:select:claim:${messageId}`)
      .setPlaceholder('Select a slot to claim')
      .addOptions(options),
  );

  await replyEphemeral(interaction, 'Select a slot to claim:', [row]);
}

async function handleLeave(interaction: ButtonInteraction): Promise<void> {
  const guildId = requireGuildId(interaction);

  if (!guildId) {
    await replyEphemeral(interaction, 'This command can only be used in a server.');
    return;
  }

  await interaction.deferUpdate();

  try {
    await leaveLobbySlot({
      client: interaction.client,
      messageId: interaction.message.id,
      discordId: interaction.user.id,
      guildId,
    });

    await replyEphemeral(interaction, 'You left the lobby.');
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await replyEphemeral(interaction, error.message);
      return;
    }

    log.error(
      { err: error, messageId: interaction.message.id, userId: interaction.user.id },
      'Failed to leave lobby',
    );
    await replyEphemeral(interaction, 'Could not update the lobby. Please try again.');
  }
}

async function handleRefresh(interaction: ButtonInteraction): Promise<void> {
  const guildId = requireGuildId(interaction);

  if (!guildId) {
    await replyEphemeral(interaction, 'This command can only be used in a server.');
    return;
  }

  await interaction.deferUpdate();

  try {
    const config = await resolveGuildConfig(guildId);
    const result = await refreshLobbyFromWc3stats({
      client: interaction.client,
      actorDiscordId: interaction.user.id,
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
      messageId: interaction.message.id,
      guildId,
    });

    await replyEphemeral(interaction, result.message);
    await maybeSendNewPlayerSuggests(interaction, result, guildId);
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await replyEphemeral(interaction, error.message);
      return;
    }

    log.error(
      { err: error, messageId: interaction.message.id, userId: interaction.user.id },
      'Failed to refresh lobby from wc3stats',
    );
    await replyEphemeral(interaction, 'Could not update the lobby. Please try again.');
  }
}

async function handleSelectClaim(
  interaction: StringSelectMenuInteraction,
  messageId: string,
): Promise<void> {
  const guildId = requireGuildId(interaction);

  if (!guildId) {
    await replyEphemeral(interaction, 'This command can only be used in a server.');
    return;
  }

  const slot = Number(interaction.values[0]);

  try {
    const result = await claimLobbySlot({
      client: interaction.client,
      messageId,
      discordId: interaction.user.id,
      guildId,
      slot,
    });
    await updateEphemeral(interaction, `Claimed slot ${slot}.`);
    await maybeSendNewPlayerSuggests(interaction, result, guildId);
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await replyEphemeral(interaction, error.message);
      return;
    }

    throw error;
  }
}

async function handleSelectEditNick(
  interaction: StringSelectMenuInteraction,
  messageId: string,
): Promise<void> {
  const result = await requirePendingMatch(messageId);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const slot = Number(interaction.values[0]);
  const player = result.players.find((entry) => entry.slot === slot);

  if (!player) {
    await replyEphemeral(interaction, 'That player is no longer in the lobby.');
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`lobby:modal:edit_nick:${messageId}:${slot}`)
    .setTitle(`Edit Nick — Slot ${slot}`);

  const nickInput = new TextInputBuilder()
    .setCustomId('nick')
    .setLabel('In-game nick')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32)
    .setValue(player.nick);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(nickInput));

  await interaction.showModal(modal);
}

async function handleSelectMovePlayer(
  interaction: StringSelectMenuInteraction,
  messageId: string,
): Promise<void> {
  const result = await requirePendingMatch(messageId);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const fromSlot = Number(interaction.values[0]);
  const player = result.players.find((entry) => entry.slot === fromSlot);

  if (!player) {
    await replyEphemeral(interaction, 'That player is no longer in the lobby.');
    return;
  }

  const profile = await getGameProfileForMatch(result.match);
  const destinations = destinationSlotSelectOptions(result.players, fromSlot, profile);

  if (destinations.length === 0) {
    await replyEphemeral(
      interaction,
      'No move or swap destinations available (other team may be full).',
    );
    return;
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`lobby:select:move_slot:${messageId}:${fromSlot}`)
      .setPlaceholder(
        profile.heroBinding === 'optional_in_game'
          ? `Move/swap ${player.nick}…`
          : `Move/swap ${player.nick} to…`,
      )
      .addOptions(destinations),
  );

  const prompt =
    profile.heroBinding === 'optional_in_game'
      ? `Select a destination for **${player.nick}**:`
      : `Select a new slot for **${player.nick}** (currently slot ${fromSlot}):`;

  await updateEphemeral(interaction, prompt, [row]);
}

async function handleSelectMoveSlot(
  interaction: StringSelectMenuInteraction,
  messageId: string,
  fromSlot: number,
): Promise<void> {
  const result = await requirePendingMatch(messageId);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const rawDestination = interaction.values[0]!;

  try {
    const profile = await getGameProfileForMatch(result.match);
    const toSlot = resolveDestinationSlot(rawDestination, result.players, profile);
    const nextPlayers = movePlayer(result.players, fromSlot, toSlot, profile);
    const updated = await applyPlayersUpdate(interaction, messageId, nextPlayers);

    if (updated) {
      await updateEphemeral(interaction, UPDATED_MESSAGE);
      await maybeSendNewPlayerSuggests(interaction, updated, interaction.guildId);
    }
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await replyEphemeral(interaction, error.message);
      return;
    }

    throw error;
  }
}

async function handleSelectRemove(
  interaction: StringSelectMenuInteraction,
  messageId: string,
): Promise<void> {
  const result = await requirePendingMatch(messageId);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const slot = Number(interaction.values[0]);

  try {
    const profile = await getGameProfileForMatch(result.match);
    const nextPlayers = removePlayer(result.players, { slot }, profile);
    const updated = await applyPlayersUpdate(interaction, messageId, nextPlayers);

    if (updated) {
      await updateEphemeral(interaction, UPDATED_MESSAGE);
      await maybeSendNewPlayerSuggests(interaction, updated, interaction.guildId);
    }
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await replyEphemeral(interaction, error.message);
      return;
    }

    throw error;
  }
}

async function handleModalEditNick(
  interaction: ModalSubmitInteraction,
  messageId: string,
  slot: number,
): Promise<void> {
  if (interaction.channelId) {
    await deletePreviousEphemeral(interaction.client, interaction.user.id, interaction.channelId);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (interaction.channelId) {
    rememberEphemeral(interaction.user.id, interaction.channelId, {
      applicationId: interaction.applicationId,
      token: interaction.token,
      messageId: '@original',
    });
  }

  const result = await requirePendingMatch(messageId);

  if ('error' in result) {
    await interaction.editReply({ content: result.error });
    return;
  }

  const nick = interaction.fields.getTextInputValue('nick');

  try {
    const profile = await getGameProfileForMatch(result.match);
    const nextPlayers = editPlayerNick(result.players, slot, nick, profile);
    const updated = await applyPlayersUpdate(interaction, messageId, nextPlayers);

    if (updated) {
      await interaction.editReply({ content: UPDATED_MESSAGE });
      await maybeSendNewPlayerSuggests(interaction, updated, interaction.guildId);
    }
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }

    throw error;
  }
}

async function handleModalAdd(
  interaction: ModalSubmitInteraction,
  messageId: string,
  teamFromSelect: TeamId | null,
): Promise<void> {
  if (interaction.channelId) {
    await deletePreviousEphemeral(interaction.client, interaction.user.id, interaction.channelId);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (interaction.channelId) {
    rememberEphemeral(interaction.user.id, interaction.channelId, {
      applicationId: interaction.applicationId,
      token: interaction.token,
      messageId: '@original',
    });
  }

  const result = await requirePendingMatch(messageId);

  if ('error' in result) {
    await interaction.editReply({ content: result.error });
    return;
  }

  const nick = interaction.fields.getTextInputValue('nick');

  try {
    const profile = await getGameProfileForMatch(result.match);
    let slot: number;

    if (teamFromSelect != null) {
      slot = nextEmptySlotOnTeam(result.players, profile, teamFromSelect);
    } else if (profile.heroBinding === 'optional_in_game') {
      await interaction.editReply({
        content: 'Pick a team from the dropdown, then enter the nick.',
      });
      return;
    } else {
      const slotRaw = interaction.fields.getTextInputValue('slot').trim();
      slot = Number(slotRaw);
      if (!Number.isInteger(slot)) {
        await interaction.editReply({
          content: invalidSlotMessage(profile),
        });
        return;
      }
    }

    const nextPlayers = addPlayer(result.players, nick, slot, profile);
    const updated = await applyPlayersUpdate(interaction, messageId, nextPlayers);

    if (updated) {
      await interaction.editReply({ content: UPDATED_MESSAGE });
      await maybeSendNewPlayerSuggests(interaction, updated, interaction.guildId);
    }
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }

    throw error;
  }
}

async function handleReportFromFile(interaction: ButtonInteraction): Promise<void> {
  const messageId = interaction.message.id;
  const result = await requirePendingMatch(messageId);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  if (!(await assertManagePendingOrReply(interaction, result.match))) {
    return;
  }

  const profile = await getGameProfileForMatch(result.match);
  if (profile.postMatchStats === 'none') {
    await replyEphemeral(interaction, 'This game does not accept match file reports.');
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`lobby:modal:report_file:${messageId}`)
    .setTitle('Paste WOS match report');

  const reportInput = new TextInputBuilder()
    .setCustomId('report_text')
    .setLabel('WOS2 bot report text')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000)
    .setPlaceholder(
      'Paste the contents of the .txt export, or use /register_lobby report: for large files.',
    );

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(reportInput));

  await interaction.showModal(modal);
}

async function handleModalReportFile(
  interaction: ModalSubmitInteraction,
  messageId: string,
): Promise<void> {
  if (interaction.channelId) {
    await deletePreviousEphemeral(interaction.client, interaction.user.id, interaction.channelId);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (interaction.channelId) {
    rememberEphemeral(interaction.user.id, interaction.channelId, {
      applicationId: interaction.applicationId,
      token: interaction.token,
      messageId: '@original',
    });
  }

  const pending = await requirePendingMatch(messageId);
  if ('error' in pending) {
    await interaction.editReply({ content: pending.error });
    return;
  }

  if (!interaction.guildId || !interaction.channelId) {
    await interaction.editReply({ content: 'This action can only be used in a server channel.' });
    return;
  }

  const config = await resolveGuildConfig(interaction.guildId);
  try {
    assertCanManageMatch({
      hostDiscordId: pending.match.hostDiscordId,
      actorDiscordId: interaction.user.id,
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
    });
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    throw error;
  }

  const rawText = interaction.fields.getTextInputValue('report_text');

  try {
    const filled = await fillLobbyFromWos2Report({
      guildId: interaction.guildId,
      leagueId: pending.match.leagueId ?? undefined,
      eventId: pending.match.eventId ?? undefined,
      hostDiscordId: interaction.user.id,
      discordChannelId: interaction.channelId,
      memberRoleIds: memberRoleIds(interaction),
      matchModRoleId: config.matchModRoleId,
      rawText,
      existingMatchId: pending.match.id,
    });

    await syncLobbyDiscordMessage(interaction.client, filled.match, 'pending');

    const warningNote = filled.warnings.length > 0 ? `\n_${filled.warnings.join(' · ')}_` : '';

    await interaction.editReply({
      content: `Lobby filled from match report.${warningNote}`,
    });

    if (filled.match.leagueId && filled.match.players.length > 0) {
      const suggestions = await collectNewPlayerSuggestionsForPendingCreate({
        leagueId: filled.match.leagueId,
        matchId: filled.matchId,
        players: filled.match.players.map((player) => ({
          playerId: player.playerId,
          username: player.player.username,
        })),
      });
      await sendNewPlayerSuggestPrompts({
        interaction,
        match: {
          id: filled.match.id,
          hostDiscordId: filled.match.hostDiscordId,
          leagueId: filled.match.leagueId,
        },
        suggestions,
        matchModRoleId: config.matchModRoleId,
      });
    }
  } catch (error) {
    if (error instanceof MatchServiceError) {
      await interaction.editReply({ content: error.message });
      return;
    }
    throw error;
  }
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const customId = interaction.customId;
  log.debug({ customId, userId: interaction.user.id }, 'Lobby button interaction');

  if (customId === LOBBY_CUSTOM_IDS.reportFromFile) {
    await handleReportFromFile(interaction);
    return;
  }

  if (customId === LOBBY_CUSTOM_IDS.start) {
    await handleStart(interaction);
    return;
  }

  if (customId === LOBBY_CUSTOM_IDS.editNick) {
    await handleEditNick(interaction);
    return;
  }

  if (customId === LOBBY_CUSTOM_IDS.move) {
    await handleMove(interaction);
    return;
  }

  if (customId === LOBBY_CUSTOM_IDS.remove) {
    await handleRemove(interaction);
    return;
  }

  if (customId === LOBBY_CUSTOM_IDS.add) {
    await handleAdd(interaction);
    return;
  }

  if (customId === LOBBY_CUSTOM_IDS.claim) {
    await handleClaim(interaction);
    return;
  }

  if (customId === LOBBY_CUSTOM_IDS.leave) {
    await handleLeave(interaction);
    return;
  }

  if (customId === LOBBY_CUSTOM_IDS.refresh) {
    await handleRefresh(interaction);
    return;
  }

  if (customId === LOBBY_CUSTOM_IDS.cancel) {
    await handleCancelEntry(interaction);
    return;
  }

  if (customId === LOBBY_CUSTOM_IDS.lockToggle) {
    await handleLockToggleEntry(interaction);
    return;
  }

  if (customId === LOBBY_CUSTOM_IDS.shuffle) {
    await handleShuffleEntry(interaction);
    return;
  }

  const parts = parseCustomId(customId);
  if (parts[1] === 'cancel' && parts[2] === 'ok' && parts[3]) {
    await handleCancelConfirm(interaction, parts[3]);
    return;
  }

  if (parts[1] === 'cancel' && parts[2] === 'no' && parts[3]) {
    await handleCancelKeep(interaction, parts[3]);
    return;
  }

  log.warn({ customId }, 'Unhandled lobby button');
}

async function handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const parts = parseCustomId(interaction.customId);
  log.debug(
    { customId: interaction.customId, values: interaction.values, userId: interaction.user.id },
    'Lobby select interaction',
  );

  if (parts[0] !== 'lobby' || parts[1] !== 'select' || !parts[3]) {
    return;
  }

  const kind = parts[2];
  const messageId = parts[3];

  if (kind === 'edit_nick') {
    await handleSelectEditNick(interaction, messageId);
    return;
  }

  if (kind === 'move_player') {
    await handleSelectMovePlayer(interaction, messageId);
    return;
  }

  if (kind === 'move_slot' && parts[4]) {
    await handleSelectMoveSlot(interaction, messageId, Number(parts[4]));
    return;
  }

  if (kind === 'remove') {
    await handleSelectRemove(interaction, messageId);
    return;
  }

  if (kind === 'add_team') {
    await handleSelectAddTeam(interaction, messageId);
    return;
  }

  if (kind === 'claim') {
    await handleSelectClaim(interaction, messageId);
    return;
  }

  if (kind === 'lock_slot') {
    await handleSelectLockSlot(interaction, messageId);
    return;
  }

  if (kind === 'shuffle_scope') {
    await handleSelectShuffleScope(interaction, messageId);
    return;
  }

  log.warn({ customId: interaction.customId }, 'Unhandled lobby select');
}

async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  const parts = parseCustomId(interaction.customId);
  log.debug({ customId: interaction.customId, userId: interaction.user.id }, 'Lobby modal submit');

  if (parts[0] !== 'lobby' || parts[1] !== 'modal' || !parts[3]) {
    return;
  }

  const kind = parts[2];
  const messageId = parts[3];

  if (kind === 'edit_nick' && parts[4]) {
    await handleModalEditNick(interaction, messageId, Number(parts[4]));
    return;
  }

  if (kind === 'add') {
    const teamPart = parts[4];
    const teamFromSelect =
      teamPart === '1' || teamPart === '2' ? (Number(teamPart) as TeamId) : null;
    await handleModalAdd(interaction, messageId, teamFromSelect);
    return;
  }

  if (kind === 'report_file') {
    await handleModalReportFile(interaction, messageId);
    return;
  }

  log.warn({ customId: interaction.customId }, 'Unhandled lobby modal');
}

/**
 * Route lobby button / select / modal interactions.
 * Returns true when the interaction was handled as a lobby action.
 */
export async function handleLobbyInteraction(interaction: Interaction): Promise<boolean> {
  if (interaction.isButton() && interaction.customId.startsWith('lobby:')) {
    await handleButton(interaction);
    return true;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('lobby:')) {
    await handleSelect(interaction);
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith('lobby:')) {
    await handleModal(interaction);
    return true;
  }

  return false;
}
