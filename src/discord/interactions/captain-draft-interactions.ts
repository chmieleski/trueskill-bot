import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type Interaction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { sendReplacingEphemeral, touchEphemeralSession } from '../../lib/ephemeral-reply.js';
import {
  applyCaptainDraftPick,
  assertCurrentCaptainPick,
  buildPickButtonCustomId,
  CaptainDraftError,
  findParticipant,
  loadDraftById,
  parseDraftState,
} from '../../services/captain-draft/index.js';
import { MatchServiceError } from '../../services/match/index.js';
import type { DraftParticipant } from '../../services/captain-draft/index.js';

const log = createLogger('captain_draft');

const PAGE_SIZE = 25;
const PAGE_NAV_PREFIX = '__page__:';

type ComponentRow = ActionRowBuilder<StringSelectMenuBuilder>;

export type CaptainDraftPickCustomId =
  { kind: 'pick_btn'; draftId: string } | { kind: 'pick_sel'; draftId: string; page: number };

/** Parse `cdraft:` pick button or select custom ids. */
export function parseCaptainDraftPickCustomId(customId: string): CaptainDraftPickCustomId | null {
  const parts = customId.split(':');
  if (parts[0] !== 'cdraft') {
    return null;
  }

  if (parts[1] === 'pick_btn' && parts[2]) {
    return { kind: 'pick_btn', draftId: parts[2] };
  }

  if (parts[1] === 'pick_sel' && parts[2] && parts[3] !== undefined) {
    const page = Number(parts[3]);
    if (!Number.isInteger(page) || page < 0) {
      return null;
    }
    return { kind: 'pick_sel', draftId: parts[2], page };
  }

  return null;
}

function buildPickSelectCustomId(draftId: string, page: number): string {
  return `cdraft:pick_sel:${draftId}:${page}`;
}

function poolPage(pool: DraftParticipant[], page: number): DraftParticipant[] {
  const start = page * PAGE_SIZE;
  return pool.slice(start, start + PAGE_SIZE);
}

function buildPickSelectRows(
  draftId: string,
  pool: DraftParticipant[],
  page: number,
): ComponentRow[] {
  const pageItems = poolPage(pool, page);
  const options = pageItems.map((player) => ({
    label: player.label.slice(0, 100),
    value: player.key,
  }));

  const totalPages = Math.ceil(pool.length / PAGE_SIZE);
  if (page > 0) {
    options.unshift({
      label: '← Previous page',
      value: `${PAGE_NAV_PREFIX}${page - 1}`,
    });
  }
  if (page + 1 < totalPages) {
    options.push({
      label: 'Next page →',
      value: `${PAGE_NAV_PREFIX}${page + 1}`,
    });
  }

  if (options.length === 0) {
    return [];
  }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildPickSelectCustomId(draftId, page))
      .setPlaceholder('Select a player to draft')
      .addOptions(options.slice(0, 25)),
  );

  return [row];
}

async function replyEphemeral(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  content: string,
  components: ComponentRow[] = [],
): Promise<void> {
  await sendReplacingEphemeral(interaction, { content, components });
}

async function updateEphemeral(
  interaction: StringSelectMenuInteraction,
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

async function showPickSelect(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  draftId: string,
  page: number,
): Promise<void> {
  const draft = await loadDraftById(draftId);
  const state = parseDraftState(draft);
  assertCurrentCaptainPick(state, interaction.user.id);

  const pool = state.memberPool;
  if (pool.length === 0) {
    await replyEphemeral(interaction, 'No players left in the pool.');
    return;
  }

  const components = buildPickSelectRows(draftId, pool, page);
  const pageCount = Math.ceil(pool.length / PAGE_SIZE);
  const pageNote = pageCount > 1 ? ` (page ${page + 1}/${pageCount})` : '';

  if (interaction.isStringSelectMenu()) {
    await updateEphemeral(interaction, `Choose a player to draft${pageNote}:`, components);
    return;
  }

  await replyEphemeral(interaction, `Choose a player to draft${pageNote}:`, components);
}

async function handlePickButton(interaction: ButtonInteraction, draftId: string): Promise<void> {
  try {
    await showPickSelect(interaction, draftId, 0);
  } catch (error) {
    if (error instanceof CaptainDraftError || error instanceof MatchServiceError) {
      await replyEphemeral(interaction, error.message);
      return;
    }
    throw error;
  }
}

async function handlePickSelect(
  interaction: StringSelectMenuInteraction,
  draftId: string,
  page: number,
): Promise<void> {
  const selected = interaction.values[0];
  if (!selected) {
    await updateEphemeral(interaction, 'No player selected.');
    return;
  }

  if (selected.startsWith(PAGE_NAV_PREFIX)) {
    const nextPage = Number(selected.slice(PAGE_NAV_PREFIX.length));
    if (!Number.isInteger(nextPage) || nextPage < 0) {
      await updateEphemeral(interaction, 'Invalid page.');
      return;
    }

    try {
      await showPickSelect(interaction, draftId, nextPage);
    } catch (error) {
      if (error instanceof CaptainDraftError || error instanceof MatchServiceError) {
        await updateEphemeral(interaction, error.message);
        return;
      }
      throw error;
    }
    return;
  }

  try {
    const draft = await loadDraftById(draftId);
    const beforeState = parseDraftState(draft);
    assertCurrentCaptainPick(beforeState, interaction.user.id);

    const updated = await applyCaptainDraftPick({
      client: interaction.client,
      draftId,
      actorDiscordId: interaction.user.id,
      participantKey: selected,
    });

    const state = parseDraftState(updated);
    const picked = findParticipant(state, selected);
    const label = picked?.label ?? 'Player';
    const statusNote = updated.status === 'COMPLETE' ? ' Draft complete.' : '';

    await updateEphemeral(interaction, `Drafted **${label}**.${statusNote}`);
  } catch (error) {
    if (error instanceof CaptainDraftError || error instanceof MatchServiceError) {
      await updateEphemeral(interaction, error.message);
      return;
    }

    log.error(
      { err: error, draftId, userId: interaction.user.id },
      'Failed to apply captain draft pick',
    );
    await updateEphemeral(interaction, 'Could not apply that pick. Please try again.');
  }
}

/**
 * Route captain draft pick button and select interactions.
 * Returns true when the interaction was handled.
 */
export async function handleCaptainDraftInteraction(interaction: Interaction): Promise<boolean> {
  if (interaction.isButton()) {
    const parsed = parseCaptainDraftPickCustomId(interaction.customId);
    if (parsed?.kind === 'pick_btn') {
      log.debug(
        { customId: interaction.customId, userId: interaction.user.id },
        'Captain draft pick button',
      );
      await handlePickButton(interaction, parsed.draftId);
      return true;
    }
    return false;
  }

  if (interaction.isStringSelectMenu()) {
    const parsed = parseCaptainDraftPickCustomId(interaction.customId);
    if (parsed?.kind === 'pick_sel') {
      log.debug(
        { customId: interaction.customId, userId: interaction.user.id, page: parsed.page },
        'Captain draft pick select',
      );
      await handlePickSelect(interaction, parsed.draftId, parsed.page);
      return true;
    }
    return false;
  }

  return false;
}

export { buildPickButtonCustomId, buildPickSelectCustomId, PAGE_SIZE };
