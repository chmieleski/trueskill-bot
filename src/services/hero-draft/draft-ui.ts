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
} from './draft-logic.js';
import { HERO_DRAFT_SEQUENCE, type HeroDraftState, type HeroPoolEntry } from './draft-types.js';

export const HERO_DRAFT_PAGE_SIZE = 25;
export const HERO_DRAFT_PAGE_NAV_PREFIX = '__page__:';

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

function formatHeroLabel(
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

function formatList(
  state: HeroDraftState,
  values: Array<number | null>,
  emojiMap: Map<number, HeroEmojiRef>,
): string {
  if (values.length === 0) {
    return '_none_';
  }
  return values.map((id) => formatHeroLabel(state, id, emojiMap)).join(', ');
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

/** Build the live or summary embed for a hero draft. */
export function buildHeroDraftEmbed(
  state: HeroDraftState,
  emojiMap: Map<number, HeroEmojiRef> = new Map(),
): EmbedBuilder {
  const turn = currentTurn(state);
  const complete = isHeroDraftComplete(state);
  const [team1, team2] = state.teams;

  const embed = new EmbedBuilder()
    .setTitle(complete ? 'Hero draft complete' : 'Hero ban / pick')
    .setColor(complete ? 0x57f287 : 0x5865f2)
    .addFields(
      {
        name: team1!.displayName,
        value: [
          `Captain: <@${team1!.captain.discordId ?? 'unknown'}>`,
          `Bans: ${formatList(state, team1!.bans, emojiMap)}`,
          `Picks: ${formatList(state, team1!.picks, emojiMap)}`,
        ].join('\n'),
        inline: false,
      },
      {
        name: team2!.displayName,
        value: [
          `Captain: <@${team2!.captain.discordId ?? 'unknown'}>`,
          `Bans: ${formatList(state, team2!.bans, emojiMap)}`,
          `Picks: ${formatList(state, team2!.picks, emojiMap)}`,
        ].join('\n'),
        inline: false,
      },
    );

  if (!complete && turn) {
    const onClock = state.teams.find((team) => team.side === turn.team)!;
    const deadline = state.actionDeadlineAt
      ? `<t:${Math.floor(new Date(state.actionDeadlineAt).getTime() / 1000)}:R>`
      : '—';
    embed.setDescription(
      `**Turn ${state.turnIndex + 1}/${HERO_DRAFT_SEQUENCE.length}:** ${turn.kind.toUpperCase()} — <@${onClock.captain.discordId}> (${deadline})`,
    );
    embed.addFields({
      name: 'Available',
      value: `${availableHeroes(state).length} heroes remaining`,
    });
  } else if (complete) {
    embed.setDescription('Draft finished. Create the lobby separately.');
  }

  return embed;
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
  const pageItems = available.slice(
    safePage * HERO_DRAFT_PAGE_SIZE,
    safePage * HERO_DRAFT_PAGE_SIZE + HERO_DRAFT_PAGE_SIZE,
  );

  const options = pageItems.map((hero) => {
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
    return option;
  });

  if (safePage > 0) {
    options.unshift({
      label: '← Previous page',
      value: `${HERO_DRAFT_PAGE_NAV_PREFIX}${safePage - 1}`,
    });
  }
  if (safePage + 1 < totalPages) {
    options.push({
      label: 'Next page →',
      value: `${HERO_DRAFT_PAGE_NAV_PREFIX}${safePage + 1}`,
    });
  }

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];
  if (options.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(buildHeroDraftCustomId('sel', draftId, safePage))
          .setPlaceholder(turn.kind === 'ban' ? 'Select a hero to ban' : 'Select a hero to pick')
          .addOptions(options.slice(0, 25)),
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
