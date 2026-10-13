import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { LobbyDraft } from '@dbz/db';
import type { GameProfile } from '../../domain/game-profile.js';
import {
  findParticipant,
  heroIdsForSide,
  heroLockedInCount,
  linkedParticipants,
  nickOf,
  onClockCaptainKey,
  votedCount,
} from './draft-logic.js';
import { HERO_PICK_HELP, type LobbyDraftState } from './draft-types.js';

export const LOBBY_DRAFT_START_ID = 'ldraft:start';
const PREFIX = 'ldraft';

export type LobbyDraftAction =
  | 'vote'
  | 'votesel'
  | 'coin'
  | 'pick'
  | 'side'
  | 'hero'
  | 'herosel'
  | 'lockin'
  | 'manage'
  | 'mrem'
  | 'mrep'
  | 'mrepm'
  | 'cancel';

export type LobbyDraftView = { profile: GameProfile; heroNames: Map<number, string> };

export function lobbyDraftCustomId(
  action: LobbyDraftAction,
  draftId: string,
  arg?: string,
): string {
  return arg === undefined
    ? `${PREFIX}:${action}:${draftId}`
    : `${PREFIX}:${action}:${draftId}:${arg}`;
}

export function parseLobbyDraftCustomId(
  customId: string,
): { action: LobbyDraftAction; draftId: string; arg?: string } | null {
  const [prefix, action, draftId, ...rest] = customId.split(':');
  if (prefix !== PREFIX || !action || !draftId) return null;
  return {
    action: action as LobbyDraftAction,
    draftId,
    ...(rest.length ? { arg: rest.join(':') } : {}),
  };
}

const PHASE_TITLES: Record<LobbyDraftState['phase'], string> = {
  VOTE: '🗳️ Vote for captains',
  COIN_CHOICE: '🪙 Coin flip choice',
  PICK: '🧩 Captains are picking',
  SIDE: '🏳️ Choosing side',
  HERO: '🦸 Hero pick',
};

function label(state: LobbyDraftState, key: string): string {
  const p = findParticipant(state, key);
  return `${p?.nick ?? key}${p?.discordId ? ' 🔗' : ''}`;
}

function sideRange(profile: GameProfile, side: 1 | 2): string {
  const ids = heroIdsForSide(profile, side);
  return `${ids[0]}–${ids.at(-1)}`;
}

export function buildLobbyDraftEmbed(
  draft: Pick<LobbyDraft, 'status'>,
  state: LobbyDraftState,
  view: LobbyDraftView,
): EmbedBuilder {
  const title =
    draft.status === 'COMPLETE'
      ? '✅ Draft complete'
      : draft.status === 'CANCELLED'
        ? '🚫 Draft cancelled'
        : PHASE_TITLES[state.phase];
  const lines: string[] = [];
  if (draft.status === 'ACTIVE' && state.deadlineAt) {
    lines.push(`Ends <t:${Math.floor(new Date(state.deadlineAt).getTime() / 1000)}:R>`);
  }
  if (draft.status === 'ACTIVE' && state.phase === 'VOTE') {
    lines.push(`${votedCount(state)}/${linkedParticipants(state).length} voted`);
  }
  if (draft.status === 'ACTIVE' && state.phase === 'HERO') {
    lines.push(`${heroLockedInCount(state)}/${linkedParticipants(state).length} locked in`);
  }
  const clock = onClockCaptainKey(state);
  if (draft.status === 'ACTIVE' && clock) lines.push(`On the clock: **${nickOf(state, clock)}**`);

  const embed = new EmbedBuilder().setTitle(title).setDescription(lines.join('\n') || '​');
  state.teams?.forEach((team, i) => {
    const name = team.side ? view.profile.teamNames[team.side] : `Team ${i + 1}`;
    const roster = team.roster.map((key) => {
      const hero = state.heroResult?.[key];
      const heroText = hero
        ? ` — ${view.heroNames.get(hero.heroId) ?? `#${hero.heroId}`}${hero.how === 'contested' ? ' 🎲' : ''}`
        : '';
      return `${key === team.captainKey ? '👑 ' : ''}${label(state, key)}${heroText}`;
    });
    embed.addFields({
      name: `${name} (${nickOf(state, team.captainKey)})`,
      value: roster.join('\n'),
      inline: true,
    });
  });
  const pool = state.teams ? state.pool : state.participants.map((p) => p.key);
  if (pool.length > 0) {
    embed.addFields({
      name: state.teams ? 'Pool' : 'Players',
      value: pool.map((k) => label(state, k)).join('\n'),
    });
  }
  if (state.log.length > 0) {
    embed.addFields({ name: 'Recent', value: state.log.slice(-5).join('\n').slice(0, 1024) });
  }
  return embed;
}

export function buildLobbyDraftComponents(
  draftId: string,
  state: LobbyDraftState,
  view: LobbyDraftView,
): Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> {
  const rows: Array<ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>> =
    [];
  const button = (id: string, text: string, style = ButtonStyle.Primary) =>
    new ButtonBuilder().setCustomId(id).setLabel(text).setStyle(style);

  if (state.phase === 'VOTE') {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(lobbyDraftCustomId('vote', draftId), 'Vote captains'),
      ),
    );
  } else if (state.phase === 'COIN_CHOICE') {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(lobbyDraftCustomId('coin', draftId, 'FIRST_PICK'), 'First pick'),
        button(lobbyDraftCustomId('coin', draftId, 'SIDE'), 'Side choice'),
      ),
    );
  } else if (state.phase === 'PICK' && state.pool.length > 0) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(lobbyDraftCustomId('pick', draftId))
          .setPlaceholder(`${nickOf(state, onClockCaptainKey(state) ?? '')}'s pick`)
          .addOptions(
            state.pool.slice(0, 25).map((key) => ({ label: label(state, key), value: key })),
          ),
      ),
    );
  } else if (state.phase === 'SIDE') {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(
          lobbyDraftCustomId('side', draftId, '1'),
          `${view.profile.teamNames[1]} (${sideRange(view.profile, 1)})`,
        ),
        button(
          lobbyDraftCustomId('side', draftId, '2'),
          `${view.profile.teamNames[2]} (${sideRange(view.profile, 2)})`,
        ),
      ),
    );
  } else if (state.phase === 'HERO') {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button(lobbyDraftCustomId('hero', draftId), 'Pick heroes'),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button(lobbyDraftCustomId('manage', draftId), 'Manage', ButtonStyle.Secondary),
      button(lobbyDraftCustomId('cancel', draftId), 'Cancel draft', ButtonStyle.Danger),
    ),
  );
  return rows;
}

export function buildVoteMenu(draftId: string, state: LobbyDraftState, actorDiscordId: string) {
  const linked = linkedParticipants(state);
  const mine = new Set(state.votes[actorDiscordId] ?? []);
  return {
    content:
      'Vote for up to 2 captains (you can vote for yourself). You can change your vote until time runs out.',
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(lobbyDraftCustomId('votesel', draftId))
          .setMinValues(1)
          .setMaxValues(Math.min(2, linked.length))
          .addOptions(
            linked
              .slice(0, 25)
              .map((p) => ({ label: p.nick, value: p.key, default: mine.has(p.key) })),
          ),
      ),
    ],
  };
}

export function buildHeroMenu(
  draftId: string,
  heroes: Array<{ id: number; name: string }>,
  current: number[],
) {
  return {
    content: HERO_PICK_HELP,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(lobbyDraftCustomId('herosel', draftId))
          .setPlaceholder('Optional: up to 2 heroes')
          .setMinValues(0)
          .setMaxValues(Math.min(2, heroes.length))
          .addOptions(
            heroes.map((h) => ({
              label: h.name,
              value: String(h.id),
              default: current.includes(h.id),
            })),
          ),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(lobbyDraftCustomId('lockin', draftId))
          .setLabel('Lock in')
          .setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

export function buildManageMenus(draftId: string, state: LobbyDraftState) {
  const options = state.participants
    .slice(0, 25)
    .map((p) => ({ label: `${p.nick}${p.discordId ? ' 🔗' : ''}`, value: p.key }));
  const select = (action: 'mrem' | 'mrep', placeholder: string) =>
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(lobbyDraftCustomId(action, draftId))
        .setPlaceholder(placeholder)
        .addOptions(options),
    );
  return {
    content: 'Replace a player who left (keeps their seat), or remove them.',
    components: [select('mrep', 'Replace a player…'), select('mrem', 'Remove a player…')],
  };
}

export function buildReplaceModal(draftId: string, key: string, nick: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(lobbyDraftCustomId('mrepm', draftId, key))
    .setTitle(`Replace ${nick}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('who')
          .setLabel('Discord @mention / user ID, or in-game nick')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(32),
      ),
    );
}
