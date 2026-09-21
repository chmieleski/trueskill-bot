import type { CaptainDraft } from '@dbz/db';
import type { Client, Guild, TextChannel } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { normalizeNick } from '../player/player-nick.js';
import { assertCurrentCaptainPick, assertTeamCaptainRename } from './draft-auth.js';
import {
  publishTeamRosters,
  refreshPublishedTeamsIfAny,
  syncLiveDraftMessage,
} from './draft-display-sync.js';
import {
  applyPick,
  buildTeamsFromCaptains,
  nextStatusAfterMutation,
  shufflePickOrder,
} from './draft-logic.js';
import { buildLiveDraftMessage } from './draft-live-embed.js';
import { resolveParticipantsFromInput } from './draft-resolve.js';
import {
  createDraft,
  findActiveDraftForChannel,
  parseDraftState,
  saveDraftState,
} from './draft-state.js';
import type { CaptainDraftStatus, DraftParticipant, DraftState } from './draft-types.js';
import { CaptainDraftError } from './draft-types.js';

const log = createLogger('captain_draft_actions');

function participantDedupeKey(participant: DraftParticipant): string {
  if (participant.discordId) {
    return `discord:${participant.discordId}`;
  }
  return `label:${normalizeNick(participant.label)}`;
}

function assertDraftStatus(draft: CaptainDraft, allowed: CaptainDraftStatus[]): void {
  const status = draft.status as CaptainDraftStatus;
  if (!allowed.includes(status)) {
    throw new CaptainDraftError(
      `Draft is ${status.toLowerCase()}; expected ${allowed.join(' or ').toLowerCase()}.`,
    );
  }
}

/** Load the newest non-cancelled draft for a channel or throw. */
export async function loadActiveDraftForChannel(
  guildId: string,
  channelId: string,
): Promise<CaptainDraft> {
  const draft = await findActiveDraftForChannel(guildId, channelId);
  if (!draft) {
    throw new CaptainDraftError('No active draft in this channel.');
  }
  return draft;
}

/** Load a draft row by id or throw. */
export async function loadDraftById(draftId: string): Promise<CaptainDraft> {
  const draft = await prisma.captainDraft.findUnique({ where: { id: draftId } });
  if (!draft) {
    throw new CaptainDraftError('Draft not found.');
  }
  return draft;
}

async function gameIdForDraft(draft: CaptainDraft): Promise<string | null> {
  if (!draft.leagueId) {
    return null;
  }

  const league = await prisma.league.findUnique({
    where: { id: draft.leagueId },
    select: { gameId: true },
  });
  return league?.gameId ?? null;
}

async function fetchTextChannel(client: Client, channelId: string): Promise<TextChannel> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    throw new CaptainDraftError('Draft channel is not available.');
  }
  return channel as TextChannel;
}

function assertNoCaptainMemberOverlap(
  captains: DraftParticipant[],
  members: DraftParticipant[],
): void {
  const captainKeys = new Set(captains.map(participantDedupeKey));
  for (const member of members) {
    if (captainKeys.has(participantDedupeKey(member))) {
      throw new CaptainDraftError('A player cannot be both a captain and a member.');
    }
  }
}

function excludeCaptainsFromMembers(
  captains: DraftParticipant[],
  members: DraftParticipant[],
): DraftParticipant[] {
  const captainKeys = new Set(captains.map(participantDedupeKey));
  return members.filter((member) => !captainKeys.has(participantDedupeKey(member)));
}

function renameTeamInState(state: DraftState, captainKey: string, name: string): DraftState {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new CaptainDraftError('Team name cannot be empty.');
  }

  let found = false;
  const teams = state.teams.map((team) => {
    if (team.captainKey !== captainKey) {
      return team;
    }
    found = true;
    return { ...team, displayName: trimmed };
  });

  if (!found) {
    throw new CaptainDraftError('Team not found.');
  }

  return { ...state, teams };
}

export async function startCaptainDraft(input: {
  guildId: string;
  channelId: string;
  hostDiscordId: string;
  leagueId?: string;
}): Promise<CaptainDraft> {
  const existing = await findActiveDraftForChannel(input.guildId, input.channelId);
  if (existing) {
    throw new CaptainDraftError(
      'A draft is already active in this channel. Finish or cancel it first.',
    );
  }

  return createDraft(input);
}

/** Replace captain list during SETUP. */
export async function setCaptains(input: {
  draftId: string;
  guild: Guild;
  raw: string;
  gameId?: string | null;
}): Promise<CaptainDraft> {
  const draft = await loadDraftById(input.draftId);
  assertDraftStatus(draft, ['SETUP']);

  const gameId = input.gameId ?? (await gameIdForDraft(draft));
  const captains = await resolveParticipantsFromInput({
    raw: input.raw,
    gameId,
    guild: input.guild,
  });

  const state = parseDraftState(draft);
  assertNoCaptainMemberOverlap(captains, state.memberPool);

  const nextState: DraftState = {
    ...state,
    captains,
    pickOrder: [],
    teams: [],
    pickIndex: 0,
  };

  return saveDraftState(draft.id, 'SETUP', nextState);
}

/** Replace member pool during SETUP; captains are excluded automatically. */
export async function setMembers(input: {
  draftId: string;
  guild: Guild;
  raw: string;
  gameId?: string | null;
}): Promise<CaptainDraft> {
  const draft = await loadDraftById(input.draftId);
  assertDraftStatus(draft, ['SETUP']);

  const gameId = input.gameId ?? (await gameIdForDraft(draft));
  const resolved = await resolveParticipantsFromInput({
    raw: input.raw,
    gameId,
    guild: input.guild,
  });

  const state = parseDraftState(draft);
  const memberPool = excludeCaptainsFromMembers(state.captains, resolved);
  assertNoCaptainMemberOverlap(state.captains, memberPool);

  return saveDraftState(draft.id, 'SETUP', { ...state, memberPool });
}

/** Shuffle pick order, build teams, post the live embed, and open pick 1. */
export async function beginCaptainDraft(input: {
  client: Client;
  draftId: string;
  rng?: () => number;
}): Promise<CaptainDraft> {
  const draft = await loadDraftById(input.draftId);
  assertDraftStatus(draft, ['SETUP']);

  const state = parseDraftState(draft);
  if (state.captains.length < 2) {
    throw new CaptainDraftError('At least two captains are required to begin.');
  }
  if (state.memberPool.length < 1) {
    throw new CaptainDraftError('At least one member is required in the pool to begin.');
  }

  const pickOrder = shufflePickOrder(state.captains.length, input.rng);
  const teams = buildTeamsFromCaptains(state.captains, pickOrder);
  const nextState: DraftState = {
    ...state,
    pickOrder,
    teams,
    pickIndex: 0,
  };

  const channel = await fetchTextChannel(input.client, draft.channelId);
  const messagePayload = buildLiveDraftMessage(draft.id, nextState, 'ACTIVE');
  const message = await channel.send(messagePayload);

  return saveDraftState(draft.id, 'ACTIVE', nextState, { draftMessageId: message.id });
}

/** Apply a snake pick for the current captain; completes the draft when the pool is empty. */
export async function applyCaptainDraftPick(input: {
  client: Client;
  draftId: string;
  actorDiscordId: string;
  participantKey: string;
}): Promise<CaptainDraft> {
  const draft = await loadDraftById(input.draftId);
  assertDraftStatus(draft, ['ACTIVE']);

  const state = parseDraftState(draft);
  assertCurrentCaptainPick(state, input.actorDiscordId);

  const nextState = applyPick(state, input.participantKey);
  const nextStatus = nextStatusAfterMutation('ACTIVE', nextState);
  const saved = await saveDraftState(draft.id, nextStatus, nextState);

  if (saved.draftMessageId) {
    await syncLiveDraftMessage(input.client, saved, { previousState: state });
  }
  await refreshPublishedTeamsIfAny(input.client, saved);

  return saved;
}

/** Cancel the channel draft and delete the live message when possible. */
export async function cancelCaptainDraft(input: {
  client: Client;
  guildId: string;
  channelId: string;
}): Promise<CaptainDraft> {
  const draft = await loadActiveDraftForChannel(input.guildId, input.channelId);
  assertDraftStatus(draft, ['SETUP', 'ACTIVE', 'COMPLETE']);

  const state = parseDraftState(draft);
  const saved = await saveDraftState(draft.id, 'CANCELLED', state);

  if (draft.draftMessageId) {
    try {
      const channel = await fetchTextChannel(input.client, draft.channelId);
      await channel.messages.delete(draft.draftMessageId);
    } catch (error) {
      log.warn({ err: error, draftId: draft.id }, 'Failed to delete live draft message on cancel');
    }
  }

  return saved;
}

/** Persist COMPLETE when an ACTIVE draft has an empty pool (heal stuck live drafts). */
async function ensureCompleteIfPoolEmpty(input: {
  client: Client;
  draft: CaptainDraft;
}): Promise<CaptainDraft> {
  const state = parseDraftState(input.draft);
  const current = input.draft.status as CaptainDraftStatus;
  const nextStatus = nextStatusAfterMutation(current, state);
  if (nextStatus === current) {
    return input.draft;
  }

  const saved = await saveDraftState(input.draft.id, nextStatus, state);
  if (saved.draftMessageId) {
    await syncLiveDraftMessage(input.client, saved);
  }
  return saved;
}

/** Captain rename after COMPLETE; refreshes published team embeds when present. */
export async function renameCaptainTeam(input: {
  client: Client;
  draftId: string;
  actorDiscordId: string;
  captainKey: string;
  name: string;
}): Promise<CaptainDraft> {
  const loaded = await loadDraftById(input.draftId);
  const draft = await ensureCompleteIfPoolEmpty({ client: input.client, draft: loaded });
  assertDraftStatus(draft, ['COMPLETE']);

  const state = parseDraftState(draft);
  assertTeamCaptainRename(state, input.actorDiscordId, input.captainKey);
  const nextState = renameTeamInState(state, input.captainKey, input.name);
  const saved = await saveDraftState(draft.id, 'COMPLETE', nextState);

  await refreshPublishedTeamsIfAny(input.client, saved);
  return saved;
}

/** Publish or refresh team roster embeds for a completed draft. */
export async function publishCaptainDraft(input: {
  client: Client;
  draftId: string;
  channel: TextChannel;
}): Promise<CaptainDraft> {
  const loaded = await loadDraftById(input.draftId);
  const draft = await ensureCompleteIfPoolEmpty({ client: input.client, draft: loaded });
  assertDraftStatus(draft, ['COMPLETE']);

  await publishTeamRosters(input.client, draft, input.channel);
  return draft;
}

export { renameTeamInState, participantDedupeKey };
