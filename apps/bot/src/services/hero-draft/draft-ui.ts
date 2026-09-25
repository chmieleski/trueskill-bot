import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type APIMessageComponentEmoji,
} from 'discord.js';
import {
  availableHeroes,
  currentTurn,
  heroNameByObjectId,
  isHeroDraftComplete,
  teamBySide,
} from './draft-logic.js';
import {
  HERO_DRAFT_SEQUENCE,
  type HeroDraftState,
  type HeroDraftTeam,
  type HeroPoolEntry,
} from './draft-types.js';

/** Heroes per select page. Discord allows 25 options; reserve 2 for ←/→ nav. */
export const HERO_DRAFT_PAGE_SIZE = 23;
export const HERO_DRAFT_PAGE_NAV_PREFIX = '__page__:';
export const HERO_DRAFT_SELECT_OPTION_MAX = 25;
export const HERO_DRAFT_EMBED_FIELD_MAX = 1024;

export type HeroEmojiRef = { id: string; name: string };

/** Build application-emoji name for a WOS hero object id. */
export function heroApplicationEmojiName(objectId: number): string {
  return `wos_${objectId}`;
}

/** Map objectId → emoji from application emoji name map. */
export function resolveHeroEmojiMap(
  emojisByName: Map<string, HeroEmojiRef>,
  pool: HeroPoolEntry[],
): Map<number, HeroEmojiRef> {
  const result = new Map<number, HeroEmojiRef>();
  for (const hero of pool) {
    const emoji = emojisByName.get(heroApplicationEmojiName(hero.objectId));
    if (emoji) {
      result.set(hero.objectId, emoji);
    }
  }
  return result;
}

function kindLabel(kind: 'ban' | 'pick'): string {
  return kind === 'ban' ? '🚫 **BAN**' : '✅ **PICK**';
}

function kindEmojiPlain(kind: 'ban' | 'pick'): string {
  return kind === 'ban' ? '🚫' : '✅';
}

/** Format a hero with application emoji when available. */
export function formatHeroLabel(
  state: HeroDraftState,
  objectId: number | null,
  emojiMap: Map<number, HeroEmojiRef>,
): string {
  if (objectId == null) {
    return '_skipped_';
  }
  const name = heroNameByObjectId(state, objectId);
  const emoji = emojiMap.get(objectId);
  return emoji ? `<:${emoji.name}:${emoji.id}> ${name}` : name;
}

/** Truncate embed field text to Discord's 1024-char limit. */
export function truncateEmbedField(text: string, max = HERO_DRAFT_EMBED_FIELD_MAX): string {
  if (text.length <= max) {
    return text;
  }
  const marker = '… +more';
  return `${text.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

function formatHeroLines(
  state: HeroDraftState,
  values: Array<number | null>,
  emojiMap: Map<number, HeroEmojiRef>,
): string {
  if (values.length === 0) {
    return '_none_';
  }
  return values.map((id) => formatHeroLabel(state, id, emojiMap)).join('\n');
}

function buildTeamFieldValue(
  state: HeroDraftState,
  team: HeroDraftTeam,
  emojiMap: Map<number, HeroEmojiRef>,
): string {
  const captain = team.captain.discordId ? `<@${team.captain.discordId}>` : team.captain.label;
  const value = [
    `Captain: ${captain}`,
    '🚫 Bans',
    formatHeroLines(state, team.bans, emojiMap),
    '✅ Picks',
    formatHeroLines(state, team.picks, emojiMap),
  ].join('\n');
  return truncateEmbedField(value);
}

export function buildHeroDraftCustomId(
  kind: 'sel' | 'skip' | 'page',
  draftId: string,
  page = 0,
): string {
  if (kind === 'skip') {
    return `hdraft:skip:${draftId}`;
  }
  if (kind === 'page') {
    return `hdraft:page:${draftId}:${page}`;
  }
  return `hdraft:sel:${draftId}:${page}`;
}

export type HeroDraftCustomId =
  | { kind: 'sel'; draftId: string; page: number }
  | { kind: 'skip'; draftId: string }
  | { kind: 'page'; draftId: string; page: number };

export function parseHeroDraftCustomId(customId: string): HeroDraftCustomId | null {
  const parts = customId.split(':');
  if (parts[0] !== 'hdraft' || !parts[1] || !parts[2]) {
    return null;
  }
  if (parts[1] === 'skip') {
    return { kind: 'skip', draftId: parts[2] };
  }
  if ((parts[1] === 'sel' || parts[1] === 'page') && parts[3] !== undefined) {
    const page = Number(parts[3]);
    if (!Number.isInteger(page) || page < 0) {
      return null;
    }
    return { kind: parts[1], draftId: parts[2], page };
  }
  return null;
}

/** Build the live or summary embed for a hero draft (dual-column duel layout). */
export function buildHeroDraftEmbed(
  state: HeroDraftState,
  emojiMap: Map<number, HeroEmojiRef> = new Map(),
): EmbedBuilder {
  const turn = currentTurn(state);
  const complete = isHeroDraftComplete(state);
  const [team1, team2] = state.teams;

  const embed = new EmbedBuilder()
    .setTitle(complete ? 'Hero draft complete' : 'Hero draft')
    .setColor(complete ? 0x57f287 : 0x5865f2)
    .addFields(
      {
        name: team1!.displayName,
        value: buildTeamFieldValue(state, team1!, emojiMap),
        inline: true,
      },
      {
        name: team2!.displayName,
        value: buildTeamFieldValue(state, team2!, emojiMap),
        inline: true,
      },
    );

  if (!complete && turn) {
    const onClock = teamBySide(state, turn.team);
    const deadline = state.actionDeadlineAt
      ? `<t:${Math.floor(new Date(state.actionDeadlineAt).getTime() / 1000)}:R>`
      : '—';
    const captainMention = onClock.captain.discordId
      ? `<@${onClock.captain.discordId}>`
      : onClock.captain.label;
    embed.setDescription(
      `On the clock: ${captainMention} · ${kindLabel(turn.kind)} · ${deadline}\n` +
        `Turn ${state.turnIndex + 1}/${HERO_DRAFT_SEQUENCE.length}`,
    );
    embed.addFields({
      name: 'Pool',
      value: truncateEmbedField(
        `${availableHeroes(state).length} heroes remaining · Select below, or \`/hero_draft select\` to ban/pick with search`,
      ),
    });
  } else if (complete) {
    embed.setDescription('Draft finished. Create the lobby separately.');
  }

  return embed;
}

export type HeroDraftActionLogResult = {
  content: string;
  mentionUserIds: string[];
};

export type HeroDraftActionLogOptions = {
  reason?: 'action' | 'timeout' | 'cancel';
};

/**
 * Build a thread action-log message from previous → next state.
 * Caller should pass `allowedMentions: { users: mentionUserIds }`.
 */
export function buildHeroDraftActionLogContent(
  previous: HeroDraftState,
  next: HeroDraftState,
  emojiMap: Map<number, HeroEmojiRef> = new Map(),
  options: HeroDraftActionLogOptions = {},
): HeroDraftActionLogResult {
  if (options.reason === 'cancel') {
    return { content: '🛑 Hero draft cancelled by a moderator.', mentionUserIds: [] };
  }

  const turn = currentTurn(previous);
  if (!turn) {
    return { content: '✅ Hero draft complete.', mentionUserIds: [] };
  }

  const acting = teamBySide(previous, turn.team);
  const actingNext = teamBySide(next, turn.team);
  const timeoutNote = options.reason === 'timeout' ? ' _(timeout)_' : '';

  let actionText: string;
  if (turn.kind === 'ban') {
    const banValue = actingNext.bans[actingNext.bans.length - 1] ?? null;
    if (banValue == null) {
      actionText = `${kindEmojiPlain('ban')} **${acting.displayName}** skipped ban${timeoutNote}`;
    } else {
      actionText = `${kindEmojiPlain('ban')} **${acting.displayName}** banned ${formatHeroLabel(previous, banValue, emojiMap)}${timeoutNote}`;
    }
  } else {
    const pickValue = actingNext.picks[actingNext.picks.length - 1];
    actionText = `${kindEmojiPlain('pick')} **${acting.displayName}** picked ${formatHeroLabel(previous, pickValue ?? null, emojiMap)}${timeoutNote}`;
  }

  const nextTurn = currentTurn(next);
  if (!nextTurn || isHeroDraftComplete(next)) {
    return {
      content: `${actionText} → ✅ **Draft complete**`,
      mentionUserIds: [],
    };
  }

  const nextTeam = teamBySide(next, nextTurn.team);
  const nextCaptainId = nextTeam.captain.discordId;
  const nextKind = kindLabel(nextTurn.kind);
  if (nextCaptainId) {
    return {
      content: `${actionText} → ${nextKind} <@${nextCaptainId}>`,
      mentionUserIds: [nextCaptainId],
    };
  }

  return {
    content: `${actionText} → ${nextKind} ${nextTeam.captain.label}`,
    mentionUserIds: [],
  };
}

/** Filter available heroes for `/hero_draft select` autocomplete. */
export function filterAvailableHeroesForAutocomplete(
  state: HeroDraftState,
  query: string,
  limit = 25,
): HeroPoolEntry[] {
  const available = availableHeroes(state);
  const normalized = query.trim().toLowerCase();
  const filtered =
    normalized.length === 0
      ? available
      : available.filter(
          (hero) =>
            hero.name.toLowerCase().includes(normalized) ||
            String(hero.objectId).includes(normalized),
        );
  return filtered.slice(0, limit);
}

/** Build message components for the active turn. */
export function buildHeroDraftComponents(
  draftId: string,
  state: HeroDraftState,
  emojiMap: Map<number, HeroEmojiRef> = new Map(),
): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
  if (isHeroDraftComplete(state)) {
    return [];
  }

  const turn = currentTurn(state);
  if (!turn) {
    return [];
  }

  const available = availableHeroes(state);
  const page = state.selectPage;
  const totalPages = Math.max(1, Math.ceil(available.length / HERO_DRAFT_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const hasPrev = safePage > 0;
  const hasNext = safePage + 1 < totalPages;
  const heroSlots = HERO_DRAFT_SELECT_OPTION_MAX - (hasPrev ? 1 : 0) - (hasNext ? 1 : 0);
  const pageItems = available.slice(
    safePage * HERO_DRAFT_PAGE_SIZE,
    safePage * HERO_DRAFT_PAGE_SIZE + Math.min(HERO_DRAFT_PAGE_SIZE, heroSlots),
  );

  const options: Array<{
    label: string;
    value: string;
    emoji?: APIMessageComponentEmoji;
  }> = [];

  if (hasPrev) {
    options.push({
      label: '← Previous page',
      value: `${HERO_DRAFT_PAGE_NAV_PREFIX}${safePage - 1}`,
    });
  }

  for (const hero of pageItems) {
    const emoji = emojiMap.get(hero.objectId);
    const option: {
      label: string;
      value: string;
      emoji?: APIMessageComponentEmoji;
    } = {
      label: hero.name.slice(0, 100),
      value: String(hero.objectId),
    };
    if (emoji) {
      option.emoji = { id: emoji.id, name: emoji.name };
    }
    options.push(option);
  }

  if (hasNext) {
    options.push({
      label: 'Next page →',
      value: `${HERO_DRAFT_PAGE_NAV_PREFIX}${safePage + 1}`,
    });
  }

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (options.length > 0) {
    const pageHint = totalPages > 1 ? ` (page ${safePage + 1}/${totalPages})` : '';
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(buildHeroDraftCustomId('sel', draftId, safePage))
          .setPlaceholder(
            turn.kind === 'ban' ? `🚫 Ban a hero${pageHint}` : `✅ Pick a hero${pageHint}`,
          )
          .addOptions(options.slice(0, HERO_DRAFT_SELECT_OPTION_MAX)),
      ),
    );
  }

  if (turn.kind === 'ban') {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(buildHeroDraftCustomId('skip', draftId))
          .setLabel('Skip ban')
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  }

  return rows;
}

export function buildHeroDraftPingContent(
  state: HeroDraftState,
  modRoleId?: string | null,
): string {
  const mentions = new Set<string>();
  for (const team of state.teams) {
    for (const member of team.roster) {
      if (member.discordId) {
        mentions.add(`<@${member.discordId}>`);
      }
    }
  }
  if (modRoleId) {
    mentions.add(`<@&${modRoleId}>`);
  }
  return `Hero draft started. ${[...mentions].join(' ')}`.trim();
}
