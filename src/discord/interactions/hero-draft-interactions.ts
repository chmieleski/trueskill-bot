import type { ButtonInteraction, Interaction, StringSelectMenuInteraction } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { sendReplacingEphemeral } from '../../lib/ephemeral-reply.js';
import {
  applyHeroBan,
  applyHeroPick,
  applyHeroSkipBan,
  changeHeroDraftSelectPage,
  currentTurn,
  HERO_DRAFT_PAGE_NAV_PREFIX,
  HeroDraftError,
  loadHeroDraftById,
  parseHeroDraftCustomId,
  parseHeroDraftState,
} from '../../services/hero-draft/index.js';
import { MatchServiceError } from '../../services/match/index.js';

const log = createLogger('hero_draft');

async function replyError(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  message: string,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await sendReplacingEphemeral(interaction, { content: message });
    return;
  }
  await sendReplacingEphemeral(interaction, { content: message });
}

async function handleSkipBan(interaction: ButtonInteraction, draftId: string): Promise<void> {
  await interaction.deferUpdate();
  await applyHeroSkipBan({
    client: interaction.client,
    draftId,
    actorDiscordId: interaction.user.id,
  });
}

async function handleSelect(
  interaction: StringSelectMenuInteraction,
  draftId: string,
): Promise<void> {
  const selected = interaction.values[0];
  if (!selected) {
    await replyError(interaction, 'No hero selected.');
    return;
  }

  if (selected.startsWith(HERO_DRAFT_PAGE_NAV_PREFIX)) {
    const nextPage = Number(selected.slice(HERO_DRAFT_PAGE_NAV_PREFIX.length));
    if (!Number.isInteger(nextPage) || nextPage < 0) {
      await replyError(interaction, 'Invalid page.');
      return;
    }
    await interaction.deferUpdate();
    await changeHeroDraftSelectPage({
      client: interaction.client,
      draftId,
      actorDiscordId: interaction.user.id,
      page: nextPage,
    });
    return;
  }

  const objectId = Number(selected);
  if (!Number.isInteger(objectId)) {
    await replyError(interaction, 'Invalid hero selection.');
    return;
  }

  const draft = await loadHeroDraftById(draftId);
  const state = parseHeroDraftState(draft);
  const turn = currentTurn(state);
  if (!turn) {
    await replyError(interaction, 'The draft is already complete.');
    return;
  }

  await interaction.deferUpdate();

  if (turn.kind === 'ban') {
    await applyHeroBan({
      client: interaction.client,
      draftId,
      actorDiscordId: interaction.user.id,
      objectId,
    });
    return;
  }

  await applyHeroPick({
    client: interaction.client,
    draftId,
    actorDiscordId: interaction.user.id,
    objectId,
  });
}

/**
 * Route hero-draft select and skip-ban interactions.
 * Returns true when the interaction was handled.
 */
export async function handleHeroDraftInteraction(interaction: Interaction): Promise<boolean> {
  if (interaction.isButton()) {
    const parsed = parseHeroDraftCustomId(interaction.customId);
    if (parsed?.kind !== 'skip') {
      return false;
    }
    try {
      await handleSkipBan(interaction, parsed.draftId);
    } catch (error) {
      if (error instanceof HeroDraftError || error instanceof MatchServiceError) {
        await replyError(interaction, error.message);
        return true;
      }
      log.error({ err: error, userId: interaction.user.id }, 'Hero draft skip failed');
      await replyError(interaction, 'Could not skip that ban. Please try again.');
    }
    return true;
  }

  if (interaction.isStringSelectMenu()) {
    const parsed = parseHeroDraftCustomId(interaction.customId);
    if (parsed?.kind !== 'sel') {
      return false;
    }
    try {
      await handleSelect(interaction, parsed.draftId);
    } catch (error) {
      if (error instanceof HeroDraftError || error instanceof MatchServiceError) {
        await replyError(interaction, error.message);
        return true;
      }
      log.error({ err: error, userId: interaction.user.id }, 'Hero draft select failed');
      await replyError(interaction, 'Could not apply that action. Please try again.');
    }
    return true;
  }

  return false;
}
