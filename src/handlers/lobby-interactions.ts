import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
import { createLogger } from '../lib/logger.js';
import {
  deleteLobbyDraft,
  getLobbyDraft,
  updateLobbyDraftPlayers,
  type LobbyDraft,
} from '../services/lobby-draft-store.js';
import {
  LobbyOcrError,
  validateLobbyPlayers,
  type LobbyPlayer,
} from '../services/lobby-ocr.js';
import {
  buildLobbyPreviewButtons,
  buildLobbyPreviewEmbed,
  LOBBY_CUSTOM_IDS,
} from '../services/lobby-preview.js';

const log = createLogger('lobby');

const MIN_SLOT = 1;
const MAX_SLOT = 12;

const OWNER_ONLY_MESSAGE = 'Only the user who registered this lobby can do that.';
const EXPIRED_MESSAGE = 'This lobby preview has expired. Run /register_lobby again.';
const UPDATED_MESSAGE = 'Lobby preview updated.';

function normalizeNick(nick: string): string {
  return nick.trim().toLowerCase();
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

function emptySlotSelectOptions(players: LobbyPlayer[]) {
  const occupied = new Set(players.map((player) => player.slot));
  const options = [];

  for (let slot = MIN_SLOT; slot <= MAX_SLOT; slot += 1) {
    if (occupied.has(slot)) {
      continue;
    }

    const team = slot <= 6 ? 'Team A' : 'Team B';
    options.push({
      label: `Slot ${slot} (${team})`,
      value: String(slot),
    });
  }

  return options;
}

async function replyEphemeral(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function updateEphemeral(
  interaction: MessageComponentInteraction,
  content: string,
  components: (
    | ActionRowBuilder<ButtonBuilder>
    | ActionRowBuilder<StringSelectMenuBuilder>
  )[] = [],
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content, components });
    return;
  }

  await interaction.update({ content, components });
}

function requireDraft(
  messageId: string,
  userId: string,
): { draft: LobbyDraft } | { error: string } {
  const draft = getLobbyDraft(messageId);

  if (!draft) {
    log.verbose({ messageId, userId }, 'Lobby draft missing or expired');
    return { error: EXPIRED_MESSAGE };
  }

  if (draft.ownerId !== userId) {
    log.warn({ messageId, userId, ownerId: draft.ownerId }, 'Lobby action rejected (not owner)');
    return { error: OWNER_ONLY_MESSAGE };
  }

  return { draft };
}

async function refreshPreviewMessage(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  messageId: string,
  players: LobbyPlayer[],
): Promise<void> {
  const validated = validateLobbyPlayers(players);
  const payload = {
    embeds: [buildLobbyPreviewEmbed(validated)],
    components: [buildLobbyPreviewButtons()],
  };

  const channel = interaction.channel;

  if (channel && 'messages' in channel) {
    await channel.messages.edit(messageId, payload);
    return;
  }

  const channelId = interaction.channelId;

  if (!channelId) {
    throw new Error('Missing channel for lobby preview update');
  }

  const fetched = await interaction.client.channels.fetch(channelId);

  if (fetched && 'messages' in fetched) {
    await fetched.messages.edit(messageId, payload);
  }
}

async function applyPlayersUpdate(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
  messageId: string,
  nextPlayers: LobbyPlayer[],
): Promise<boolean> {
  try {
    validateLobbyPlayers(nextPlayers);
  } catch (error) {
    log.warn(
      {
        err: error,
        messageId,
        userId: interaction.user.id,
        playerCount: nextPlayers.length,
      },
      'Lobby players update rejected by validation',
    );

    const content =
      error instanceof LobbyOcrError
        ? error.message
        : 'Invalid lobby changes. Please try again.';

    await replyEphemeral(interaction, content);
    return false;
  }

  const updated = updateLobbyDraftPlayers(messageId, nextPlayers);

  if (!updated) {
    log.warn({ messageId, userId: interaction.user.id }, 'Lobby draft gone during players update');
    await replyEphemeral(interaction, EXPIRED_MESSAGE);
    return false;
  }

  try {
    await refreshPreviewMessage(interaction, messageId, updated.players);
    log.debug(
      { messageId, revision: updated.revision, playerCount: updated.players.length },
      'Lobby preview message refreshed',
    );
  } catch (error) {
    log.error({ err: error, messageId }, 'Failed to refresh preview message');
    await replyEphemeral(interaction, 'Could not update the lobby preview message.');
    return false;
  }

  return true;
}

function buildFixMenuRow(messageId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`lobby:fix:edit_nick:${messageId}`)
      .setLabel('Edit Nick')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`lobby:fix:move:${messageId}`)
      .setLabel('Change Slot')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`lobby:fix:remove:${messageId}`)
      .setLabel('Remove')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`lobby:fix:add:${messageId}`)
      .setLabel('Add')
      .setStyle(ButtonStyle.Success),
  );
}

async function handleConfirm(interaction: ButtonInteraction): Promise<void> {
  const messageId = interaction.message.id;
  const result = requireDraft(messageId, interaction.user.id);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  // TODO: Persist match / MatchPlayer / OpenSkill from result.draft.players
  const { teamA, teamB } = validateLobbyPlayers(result.draft.players);

  log.info(
    {
      messageId,
      userId: interaction.user.id,
      teamA: teamA.length,
      teamB: teamB.length,
    },
    'Lobby teams confirmed',
  );

  deleteLobbyDraft(messageId);

  await interaction.update({
    embeds: [buildLobbyPreviewEmbed({ teamA, teamB })],
    components: [buildLobbyPreviewButtons({ disabled: true })],
  });

  await interaction.followUp({
    content: 'Teams confirmed. Match registration will be available soon.',
    flags: MessageFlags.Ephemeral,
  });
}

async function handleFixOpen(interaction: ButtonInteraction): Promise<void> {
  const messageId = interaction.message.id;
  const result = requireDraft(messageId, interaction.user.id);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  await interaction.reply({
    content: 'Choose a correction:',
    components: [buildFixMenuRow(messageId)],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleFixEditNick(interaction: ButtonInteraction, messageId: string): Promise<void> {
  const result = requireDraft(messageId, interaction.user.id);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const options = playerSelectOptions(result.draft.players);

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

  await updateEphemeral(interaction, 'Select a player to edit their nick:', [row]);
}

async function handleFixMove(interaction: ButtonInteraction, messageId: string): Promise<void> {
  const result = requireDraft(messageId, interaction.user.id);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const options = playerSelectOptions(result.draft.players);

  if (options.length === 0) {
    await replyEphemeral(interaction, 'No players to move.');
    return;
  }

  const freeSlots = emptySlotSelectOptions(result.draft.players);

  if (freeSlots.length === 0) {
    await replyEphemeral(interaction, 'No empty slots available to move into.');
    return;
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`lobby:select:move_player:${messageId}`)
      .setPlaceholder('Select a player to move')
      .addOptions(options),
  );

  await updateEphemeral(interaction, 'Select a player to change their slot:', [row]);
}

async function handleFixRemove(interaction: ButtonInteraction, messageId: string): Promise<void> {
  const result = requireDraft(messageId, interaction.user.id);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const options = playerSelectOptions(result.draft.players);

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

  await updateEphemeral(interaction, 'Select a player to remove:', [row]);
}

async function handleFixAdd(interaction: ButtonInteraction, messageId: string): Promise<void> {
  const result = requireDraft(messageId, interaction.user.id);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  if (emptySlotSelectOptions(result.draft.players).length === 0) {
    await replyEphemeral(interaction, 'No empty slots available. Remove a player first.');
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
    .setLabel('Slot number (1-12)')
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

async function handleSelectEditNick(
  interaction: StringSelectMenuInteraction,
  messageId: string,
): Promise<void> {
  const result = requireDraft(messageId, interaction.user.id);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const slot = Number(interaction.values[0]);
  const player = result.draft.players.find((entry) => entry.slot === slot);

  if (!player) {
    await replyEphemeral(interaction, 'That player is no longer in the lobby preview.');
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
  const result = requireDraft(messageId, interaction.user.id);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const fromSlot = Number(interaction.values[0]);
  const player = result.draft.players.find((entry) => entry.slot === fromSlot);

  if (!player) {
    await replyEphemeral(interaction, 'That player is no longer in the lobby preview.');
    return;
  }

  const freeSlots = emptySlotSelectOptions(result.draft.players);

  if (freeSlots.length === 0) {
    await replyEphemeral(interaction, 'No empty slots available to move into.');
    return;
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`lobby:select:move_slot:${messageId}:${fromSlot}`)
      .setPlaceholder(`Move ${player.nick} to…`)
      .addOptions(freeSlots),
  );

  await updateEphemeral(
    interaction,
    `Select a new slot for **${player.nick}** (currently slot ${fromSlot}):`,
    [row],
  );
}

async function handleSelectMoveSlot(
  interaction: StringSelectMenuInteraction,
  messageId: string,
  fromSlot: number,
): Promise<void> {
  const result = requireDraft(messageId, interaction.user.id);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const toSlot = Number(interaction.values[0]);

  if (!Number.isInteger(toSlot) || toSlot < MIN_SLOT || toSlot > MAX_SLOT) {
    await replyEphemeral(interaction, `Invalid slot. Slots must be between ${MIN_SLOT} and ${MAX_SLOT}.`);
    return;
  }

  if (result.draft.players.some((player) => player.slot === toSlot)) {
    await replyEphemeral(interaction, `Slot ${toSlot} is already occupied.`);
    return;
  }

  const nextPlayers = result.draft.players.map((player) =>
    player.slot === fromSlot ? { ...player, slot: toSlot } : player,
  );

  const ok = await applyPlayersUpdate(interaction, messageId, nextPlayers);

  if (ok) {
    await updateEphemeral(interaction, UPDATED_MESSAGE);
  }
}

async function handleSelectRemove(
  interaction: StringSelectMenuInteraction,
  messageId: string,
): Promise<void> {
  const result = requireDraft(messageId, interaction.user.id);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const slot = Number(interaction.values[0]);
  const nextPlayers = result.draft.players.filter((player) => player.slot !== slot);

  const ok = await applyPlayersUpdate(interaction, messageId, nextPlayers);

  if (ok) {
    await updateEphemeral(interaction, UPDATED_MESSAGE);
  }
}

async function handleModalEditNick(
  interaction: ModalSubmitInteraction,
  messageId: string,
  slot: number,
): Promise<void> {
  const result = requireDraft(messageId, interaction.user.id);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const nick = normalizeNick(interaction.fields.getTextInputValue('nick'));

  if (nick === '') {
    await replyEphemeral(interaction, 'Nick cannot be empty.');
    return;
  }

  if (!result.draft.players.some((player) => player.slot === slot)) {
    await replyEphemeral(interaction, 'That player is no longer in the lobby preview.');
    return;
  }

  const nextPlayers = result.draft.players.map((player) =>
    player.slot === slot ? { ...player, nick } : player,
  );

  const ok = await applyPlayersUpdate(interaction, messageId, nextPlayers);

  if (ok) {
    await interaction.reply({ content: UPDATED_MESSAGE, flags: MessageFlags.Ephemeral });
  }
}

async function handleModalAdd(
  interaction: ModalSubmitInteraction,
  messageId: string,
): Promise<void> {
  const result = requireDraft(messageId, interaction.user.id);

  if ('error' in result) {
    await replyEphemeral(interaction, result.error);
    return;
  }

  const nick = normalizeNick(interaction.fields.getTextInputValue('nick'));
  const slotRaw = interaction.fields.getTextInputValue('slot').trim();
  const slot = Number(slotRaw);

  if (nick === '') {
    await replyEphemeral(interaction, 'Nick cannot be empty.');
    return;
  }

  if (!Number.isInteger(slot) || slot < MIN_SLOT || slot > MAX_SLOT) {
    await replyEphemeral(
      interaction,
      `Invalid slot ${slotRaw}. Slots must be between ${MIN_SLOT} and ${MAX_SLOT}.`,
    );
    return;
  }

  if (result.draft.players.some((player) => player.slot === slot)) {
    await replyEphemeral(interaction, `Slot ${slot} is already occupied.`);
    return;
  }

  const nextPlayers = [...result.draft.players, { slot, nick }];
  const ok = await applyPlayersUpdate(interaction, messageId, nextPlayers);

  if (ok) {
    await interaction.reply({ content: UPDATED_MESSAGE, flags: MessageFlags.Ephemeral });
  }
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const customId = interaction.customId;
  log.debug({ customId, userId: interaction.user.id }, 'Lobby button interaction');

  if (customId === LOBBY_CUSTOM_IDS.confirm) {
    await handleConfirm(interaction);
    return;
  }

  if (customId === LOBBY_CUSTOM_IDS.fix) {
    await handleFixOpen(interaction);
    return;
  }

  const parts = parseCustomId(customId);

  // lobby:fix:edit_nick:{msgId}
  if (parts[0] === 'lobby' && parts[1] === 'fix' && parts[3]) {
    const messageId = parts[3];
    const action = parts[2];

    if (action === 'edit_nick') {
      await handleFixEditNick(interaction, messageId);
      return;
    }

    if (action === 'move') {
      await handleFixMove(interaction, messageId);
      return;
    }

    if (action === 'remove') {
      await handleFixRemove(interaction, messageId);
      return;
    }

    if (action === 'add') {
      await handleFixAdd(interaction, messageId);
      return;
    }

    log.warn({ customId }, 'Unhandled lobby fix button');
  }
}

async function handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const parts = parseCustomId(interaction.customId);
  log.debug(
    { customId: interaction.customId, values: interaction.values, userId: interaction.user.id },
    'Lobby select interaction',
  );

  // lobby:select:edit_nick:{msgId}
  // lobby:select:move_player:{msgId}
  // lobby:select:move_slot:{msgId}:{fromSlot}
  // lobby:select:remove:{msgId}
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

  log.warn({ customId: interaction.customId }, 'Unhandled lobby select');
}

async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  const parts = parseCustomId(interaction.customId);
  log.debug({ customId: interaction.customId, userId: interaction.user.id }, 'Lobby modal submit');

  // lobby:modal:edit_nick:{msgId}:{slot}
  // lobby:modal:add:{msgId}
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
    await handleModalAdd(interaction, messageId);
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
