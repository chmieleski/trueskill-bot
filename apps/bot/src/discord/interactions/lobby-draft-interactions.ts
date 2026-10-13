import {
  MessageFlags,
  type ButtonInteraction,
  type Interaction,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { resolveGuildConfig } from '../../services/guild/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import {
  buildHeroMenu,
  buildManageMenus,
  buildReplaceModal,
  buildVoteMenu,
  cancelLobbyDraftByUser,
  chooseCoinOption,
  chooseSide,
  getHeroMenuForActor,
  getManageMenuForActor,
  getVoteMenuForActor,
  LOBBY_DRAFT_START_ID,
  LobbyDraftError,
  lockInHeroes,
  manageRemove,
  manageReplace,
  nickOf,
  parseLobbyDraftCustomId,
  pickPlayer,
  setHeroPreferences,
  startLobbyDraft,
  voteCaptains,
} from '../../services/lobby-draft/index.js';
import { memberRoleIds } from './lobby-interactions.js';

const log = createLogger('lobby_draft');

type DraftInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

async function manageAuth(interaction: DraftInteraction) {
  const config = interaction.guildId ? await resolveGuildConfig(interaction.guildId) : undefined;
  return {
    actorDiscordId: interaction.user.id,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: config?.matchModRoleId,
  };
}

async function ephemeral(
  interaction: DraftInteraction,
  payload: Omit<InteractionReplyOptions, 'flags'>,
): Promise<void> {
  const body: InteractionReplyOptions = { ...payload, flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) await interaction.followUp(body);
  else await interaction.reply(body);
}

async function route(interaction: DraftInteraction): Promise<boolean> {
  const client = interaction.client;
  const actorDiscordId = interaction.user.id;

  if (interaction.isButton() && interaction.customId === LOBBY_DRAFT_START_ID) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await startLobbyDraft({
      client,
      messageId: interaction.message.id,
      ...(await manageAuth(interaction)),
    });
    await interaction.editReply({ content: 'Captain draft started — see the thread.' });
    return true;
  }

  const parsed = parseLobbyDraftCustomId(interaction.customId);
  if (!parsed) return false;
  const { action, draftId, arg } = parsed;

  if (interaction.isButton()) {
    switch (action) {
      case 'vote':
        await ephemeral(
          interaction,
          buildVoteMenu(draftId, await getVoteMenuForActor(draftId, actorDiscordId)),
        );
        return true;
      case 'hero': {
        const { heroes, current } = await getHeroMenuForActor(draftId, actorDiscordId);
        await ephemeral(interaction, buildHeroMenu(draftId, heroes, current));
        return true;
      }
      case 'manage':
        await ephemeral(
          interaction,
          buildManageMenus(
            draftId,
            await getManageMenuForActor(draftId, await manageAuth(interaction)),
          ),
        );
        return true;
      case 'coin':
        await interaction.deferUpdate();
        await chooseCoinOption({
          client,
          draftId,
          actorDiscordId,
          choice: arg === 'SIDE' ? 'SIDE' : 'FIRST_PICK',
        });
        return true;
      case 'side':
        await interaction.deferUpdate();
        await chooseSide({ client, draftId, actorDiscordId, side: arg === '2' ? 2 : 1 });
        return true;
      case 'lockin':
        await interaction.deferUpdate();
        await lockInHeroes({ client, draftId, actorDiscordId });
        await interaction.editReply({
          content: '🔒 Locked in. Waiting for the others…',
          components: [],
        });
        return true;
      case 'cancel':
        await interaction.deferUpdate();
        await cancelLobbyDraftByUser({ client, draftId, ...(await manageAuth(interaction)) });
        return true;
      default:
        return false;
    }
  }

  if (interaction.isStringSelectMenu()) {
    switch (action) {
      case 'votesel':
        await interaction.deferUpdate();
        await voteCaptains({ client, draftId, actorDiscordId, keys: interaction.values });
        await interaction.editReply({
          content: '🗳️ Vote saved. You can change it until time runs out.',
          components: [],
        });
        return true;
      case 'pick':
        await interaction.deferUpdate();
        await pickPlayer({ client, draftId, actorDiscordId, key: interaction.values[0]! });
        return true;
      case 'herosel':
        await interaction.deferUpdate();
        await setHeroPreferences({
          client,
          draftId,
          actorDiscordId,
          heroIds: interaction.values.map(Number),
        });
        return true;
      case 'mrem':
        await interaction.deferUpdate();
        await manageRemove({
          client,
          draftId,
          key: interaction.values[0]!,
          ...(await manageAuth(interaction)),
        });
        await interaction.editReply({ content: 'Player removed.', components: [] });
        return true;
      case 'mrep': {
        const key = interaction.values[0]!;
        const state = await getManageMenuForActor(draftId, await manageAuth(interaction));
        await interaction.showModal(buildReplaceModal(draftId, key, nickOf(state, key)));
        return true;
      }
      default:
        return false;
    }
  }

  if (interaction.isModalSubmit() && action === 'mrepm' && arg) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await manageReplace({
      client,
      draftId,
      key: arg,
      who: interaction.fields.getTextInputValue('who'),
      ...(await manageAuth(interaction)),
    });
    await interaction.editReply({ content: 'Player replaced.' });
    return true;
  }
  return false;
}

/** Route `ldraft:*` components and the lobby "Captain draft" button. */
export async function handleLobbyDraftInteraction(interaction: Interaction): Promise<boolean> {
  if (
    !interaction.isButton() &&
    !interaction.isStringSelectMenu() &&
    !interaction.isModalSubmit()
  ) {
    return false;
  }
  try {
    return await route(interaction);
  } catch (error) {
    if (error instanceof LobbyDraftError || error instanceof MatchServiceError) {
      await ephemeral(interaction, { content: error.message });
      return true;
    }
    log.error({ err: error, customId: interaction.customId }, 'Lobby draft interaction failed');
    await ephemeral(interaction, { content: 'Could not apply that action. Please try again.' });
    return true;
  }
}
