import { ChannelType, type Client, type Guild, type TextChannel } from 'discord.js';
import type { HeroDraft } from '@prisma/client';
import { WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { resolveGuildConfig } from '../guild/guild-config.js';
import {
  applyBan,
  applyPick,
  applySkipBan,
  applyTimeout,
  isHeroDraftComplete,
  setActionDeadline,
  setSelectPage,
} from './draft-logic.js';
import { assertOnClockCaptain } from './draft-auth.js';
import {
  loadHeroDraftById,
  parseHeroDraftState,
  saveHeroDraftState,
  serializeHeroDraftState,
} from './draft-state.js';
import {
  emptyHeroDraftState,
  HeroDraftError,
  type HeroDraftState,
  type HeroDraftTeam,
} from './draft-types.js';
import {
  buildHeroDraftComponents,
  buildHeroDraftEmbed,
  buildHeroDraftPingContent,
  resolveHeroEmojiMap,
  type HeroEmojiRef,
} from './draft-ui.js';
import { clearHeroDraftTimer, scheduleHeroDraftTimeout } from './draft-timer.js';
import { snapshotGameHeroPool } from './draft-teams.js';

const log = createLogger('hero_draft');

async function loadEmojiMap(
  client: Client,
  state: HeroDraftState,
): Promise<Map<number, HeroEmojiRef>> {
  try {
    if (!client.application) {
      return new Map();
    }
    const emojis = await client.application.emojis.fetch();
    const byName = new Map<string, HeroEmojiRef>();
    for (const emoji of emojis.values()) {
      if (emoji.name) {
        byName.set(emoji.name, { id: emoji.id, name: emoji.name });
      }
    }
    return resolveHeroEmojiMap(byName, state.pool);
  } catch (error) {
    log.warn({ err: error }, 'Failed to fetch application emojis for hero draft');
    return new Map();
  }
}

function deadlineFromNow(timerSeconds: number): string {
  return new Date(Date.now() + timerSeconds * 1000).toISOString();
}

async function persistAndSchedule(
  client: Client,
  draft: HeroDraft,
  state: HeroDraftState,
  status: 'ACTIVE' | 'COMPLETE' | 'CANCELLED',
): Promise<HeroDraft> {
  let nextState = state;
  if (status === 'ACTIVE' && !isHeroDraftComplete(nextState)) {
    nextState = setActionDeadline(nextState, deadlineFromNow(draft.timerSeconds));
  } else {
    nextState = setActionDeadline(nextState, null);
    clearHeroDraftTimer(draft.id);
  }

  const saved = await saveHeroDraftState(draft.id, status, nextState, {
    liveMessageId: draft.liveMessageId,
  });

  if (status === 'ACTIVE' && nextState.actionDeadlineAt) {
    scheduleHeroDraftTimeout(client, saved.id, nextState.actionDeadlineAt);
  }

  await syncHeroDraftLiveMessage(client, saved.id);
  return saved;
}

/** Refresh the live draft message from current DB state. */
export async function syncHeroDraftLiveMessage(client: Client, draftId: string): Promise<void> {
  const draft = await loadHeroDraftById(draftId);
  if (!draft.liveMessageId) {
    return;
  }

  const state = parseHeroDraftState(draft);
  const emojiMap = await loadEmojiMap(client, state);
  const embed = buildHeroDraftEmbed(state, emojiMap);
  const components =
    draft.status === 'ACTIVE' ? buildHeroDraftComponents(draft.id, state, emojiMap) : [];

  try {
    const channel = await client.channels.fetch(draft.threadId);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      return;
    }
    const message = await channel.messages.fetch(draft.liveMessageId);
    await message.edit({ embeds: [embed], components });
  } catch (error) {
    log.warn({ err: error, draftId }, 'Failed to sync hero draft live message');
  }
}

export type StartHeroDraftInput = {
  client: Client;
  guild: Guild;
  parentChannel: TextChannel;
  hostDiscordId: string;
  leagueId: string;
  gameId: string;
  team1: HeroDraftTeam;
  team2: HeroDraftTeam;
  timerSeconds?: number;
  sourceCaptainDraftId?: string | null;
};

/** Create a public thread and begin an ACTIVE hero draft. */
export async function startHeroDraft(input: StartHeroDraftInput): Promise<HeroDraft> {
  if (input.gameId !== WARCRAFT3_WOS_GAME_ID) {
    throw new HeroDraftError('Hero draft is only available for Warcraft III WOS leagues.');
  }
  if (input.team1.side !== 1 || input.team2.side !== 2) {
    throw new HeroDraftError('Teams must be assigned as side 1 and side 2.');
  }
  if (!input.team1.captain.discordId || !input.team2.captain.discordId) {
    throw new HeroDraftError('Both captains must be linked to Discord.');
  }

  const timerSeconds =
    input.timerSeconds !== undefined && Number.isFinite(input.timerSeconds)
      ? Math.max(5, Math.min(300, Math.floor(input.timerSeconds)))
      : 30;

  const pool = await snapshotGameHeroPool(input.gameId);
  let state = emptyHeroDraftState([input.team1, input.team2], pool);
  state = setActionDeadline(state, deadlineFromNow(timerSeconds));

  const threadName = `hero-draft-${input.team1.displayName}-vs-${input.team2.displayName}`.slice(
    0,
    100,
  );

  const thread = await input.parentChannel.threads.create({
    name: threadName,
    type: ChannelType.PublicThread,
    autoArchiveDuration: 1440,
    reason: 'WOS hero ban/pick draft',
  });

  const guildConfig = await resolveGuildConfig(input.guild.id);
  const pingContent = buildHeroDraftPingContent(state, guildConfig.matchModRoleId);

  const draft = await prisma.heroDraft.create({
    data: {
      guildId: input.guild.id,
      leagueId: input.leagueId,
      parentChannelId: input.parentChannel.id,
      threadId: thread.id,
      hostDiscordId: input.hostDiscordId,
      status: 'ACTIVE',
      timerSeconds,
      state: serializeHeroDraftState(state),
      sourceCaptainDraftId: input.sourceCaptainDraftId ?? null,
    },
  });

  const emojiMap = await loadEmojiMap(input.client, state);
  const message = await thread.send({
    content: pingContent,
    embeds: [buildHeroDraftEmbed(state, emojiMap)],
    components: buildHeroDraftComponents(draft.id, state, emojiMap),
  });

  const saved = await prisma.heroDraft.update({
    where: { id: draft.id },
    data: { liveMessageId: message.id },
  });

  scheduleHeroDraftTimeout(input.client, saved.id, state.actionDeadlineAt);
  log.info({ draftId: saved.id, threadId: thread.id }, 'Hero draft started');
  return saved;
}

export async function cancelHeroDraft(input: {
  client: Client;
  draftId: string;
}): Promise<HeroDraft> {
  const draft = await loadHeroDraftById(input.draftId);
  if (draft.status !== 'ACTIVE') {
    throw new HeroDraftError('Only an active hero draft can be cancelled.');
  }

  clearHeroDraftTimer(draft.id);
  const state = setActionDeadline(parseHeroDraftState(draft), null);
  const saved = await saveHeroDraftState(draft.id, 'CANCELLED', state);
  await syncHeroDraftLiveMessage(input.client, saved.id);

  try {
    const channel = await input.client.channels.fetch(draft.threadId);
    if (channel?.isTextBased() && !channel.isDMBased()) {
      await channel.send('Hero draft cancelled by a moderator.');
    }
  } catch {
    // ignore
  }

  return saved;
}

async function applyMutation(input: {
  client: Client;
  draftId: string;
  actorDiscordId: string;
  mutate: (state: HeroDraftState) => HeroDraftState;
}): Promise<HeroDraft> {
  const draft = await loadHeroDraftById(input.draftId);
  if (draft.status !== 'ACTIVE') {
    throw new HeroDraftError('This hero draft is not active.');
  }

  const state = parseHeroDraftState(draft);
  assertOnClockCaptain(state, input.actorDiscordId);
  clearHeroDraftTimer(draft.id);

  let next = input.mutate(state);
  const status = isHeroDraftComplete(next) ? 'COMPLETE' : 'ACTIVE';
  return persistAndSchedule(input.client, draft, next, status);
}

export async function applyHeroBan(input: {
  client: Client;
  draftId: string;
  actorDiscordId: string;
  objectId: number;
}): Promise<HeroDraft> {
  return applyMutation({
    client: input.client,
    draftId: input.draftId,
    actorDiscordId: input.actorDiscordId,
    mutate: (state) => applyBan(state, input.objectId),
  });
}

export async function applyHeroPick(input: {
  client: Client;
  draftId: string;
  actorDiscordId: string;
  objectId: number;
}): Promise<HeroDraft> {
  return applyMutation({
    client: input.client,
    draftId: input.draftId,
    actorDiscordId: input.actorDiscordId,
    mutate: (state) => applyPick(state, input.objectId),
  });
}

export async function applyHeroSkipBan(input: {
  client: Client;
  draftId: string;
  actorDiscordId: string;
}): Promise<HeroDraft> {
  return applyMutation({
    client: input.client,
    draftId: input.draftId,
    actorDiscordId: input.actorDiscordId,
    mutate: (state) => applySkipBan(state),
  });
}

export async function changeHeroDraftSelectPage(input: {
  client: Client;
  draftId: string;
  actorDiscordId: string;
  page: number;
}): Promise<HeroDraft> {
  const draft = await loadHeroDraftById(input.draftId);
  if (draft.status !== 'ACTIVE') {
    throw new HeroDraftError('This hero draft is not active.');
  }
  const state = parseHeroDraftState(draft);
  assertOnClockCaptain(state, input.actorDiscordId);
  const next = setSelectPage(state, input.page);
  const saved = await saveHeroDraftState(draft.id, 'ACTIVE', next);
  await syncHeroDraftLiveMessage(input.client, saved.id);
  return saved;
}

/** Timer / overdue path — no captain auth. */
export async function applyTimeoutAction(input: {
  client: Client;
  draftId: string;
}): Promise<HeroDraft | null> {
  const draft = await loadHeroDraftById(input.draftId);
  if (draft.status !== 'ACTIVE') {
    return null;
  }

  const state = parseHeroDraftState(draft);
  if (state.actionDeadlineAt) {
    const deadlineMs = new Date(state.actionDeadlineAt).getTime();
    if (Date.now() + 50 < deadlineMs) {
      // Rescheduled / raced — ignore
      scheduleHeroDraftTimeout(input.client, draft.id, state.actionDeadlineAt);
      return draft;
    }
  }

  clearHeroDraftTimer(draft.id);
  let next = applyTimeout(state);
  const status = isHeroDraftComplete(next) ? 'COMPLETE' : 'ACTIVE';
  return persistAndSchedule(input.client, draft, next, status);
}
