import type { CaptainDraft } from '@prisma/client';
import type { Client } from 'discord.js';
import {
  addToPool,
  addToTeam,
  applyPick,
  moveParticipant,
  nextStatusAfterMutation,
  removeFromPool,
  removeFromTeam,
  replaceParticipant,
  swapParticipants,
  undoLastPick,
} from './draft-logic.js';
import {
  loadActiveDraftForChannel,
  participantDedupeKey,
  renameTeamInState,
} from './draft-actions.js';
import { refreshPublishedTeamsIfAny, syncLiveDraftMessage } from './draft-display-sync.js';
import { parseDraftState, saveDraftState } from './draft-state.js';
import type { CaptainDraftStatus, DraftParticipant, DraftState } from './draft-types.js';
import { CaptainDraftError } from './draft-types.js';

function assertDraftStatus(draft: CaptainDraft, allowed: CaptainDraftStatus[]): void {
  const status = draft.status as CaptainDraftStatus;
  if (!allowed.includes(status)) {
    throw new CaptainDraftError(
      `Draft is ${status.toLowerCase()}; expected ${allowed.join(' or ').toLowerCase()}.`,
    );
  }
}

function participantLocation(state: DraftState, key: string): 'pool' | 'team' | 'missing' {
  if (state.memberPool.some((player) => player.key === key)) {
    return 'pool';
  }
  for (const team of state.teams) {
    if (team.roster.some((player) => player.key === key)) {
      return 'team';
    }
  }
  return 'missing';
}

async function persistAndRefresh(
  client: Client,
  draft: CaptainDraft,
  status: CaptainDraftStatus,
  state: DraftState,
  previousState?: DraftState,
): Promise<CaptainDraft> {
  const nextStatus = nextStatusAfterMutation(status, state);
  const saved = await saveDraftState(draft.id, nextStatus, state);

  if (status === 'ACTIVE' && saved.draftMessageId) {
    await syncLiveDraftMessage(client, saved, { previousState });
  }

  if (nextStatus === 'ACTIVE' || nextStatus === 'COMPLETE') {
    await refreshPublishedTeamsIfAny(client, saved);
  }

  return saved;
}

function assertPlayerNotInDraft(state: DraftState, player: DraftParticipant): void {
  const dedupeKey = participantDedupeKey(player);
  const exists =
    state.memberPool.some((entry) => participantDedupeKey(entry) === dedupeKey) ||
    state.captains.some((entry) => participantDedupeKey(entry) === dedupeKey) ||
    state.teams.some((team) =>
      team.roster.some((entry) => participantDedupeKey(entry) === dedupeKey),
    );

  if (exists) {
    throw new CaptainDraftError('Player is already in this draft.');
  }
}

/** Mod: add a player to the pool or directly to a team roster. */
export async function modAddPlayer(input: {
  client: Client;
  guildId: string;
  channelId: string;
  player: DraftParticipant;
  teamCaptainKey?: string;
}): Promise<CaptainDraft> {
  const draft = await loadActiveDraftForChannel(input.guildId, input.channelId);
  assertDraftStatus(draft, ['SETUP', 'ACTIVE', 'COMPLETE']);

  const state = parseDraftState(draft);
  const status = draft.status as CaptainDraftStatus;

  if (status === 'COMPLETE') {
    if (!input.teamCaptainKey) {
      throw new CaptainDraftError('Choose a team when adding a player after the draft has teams.');
    }
    assertPlayerNotInDraft(state, input.player);
    const nextState = addToTeam(
      addToPool(state, input.player),
      input.player.key,
      input.teamCaptainKey,
    );
    return persistAndRefresh(input.client, draft, status, nextState, state);
  }

  if (status === 'ACTIVE' && input.teamCaptainKey) {
    assertPlayerNotInDraft(state, input.player);
    const nextState = addToTeam(
      addToPool(state, input.player),
      input.player.key,
      input.teamCaptainKey,
    );
    return persistAndRefresh(input.client, draft, status, nextState, state);
  }

  assertPlayerNotInDraft(state, input.player);
  const nextState = addToPool(state, input.player);
  return persistAndRefresh(input.client, draft, status, nextState, state);
}

/** Mod: remove a player from the pool or a team roster (not captains). */
export async function modRemovePlayer(input: {
  client: Client;
  guildId: string;
  channelId: string;
  participantKey: string;
}): Promise<CaptainDraft> {
  const draft = await loadActiveDraftForChannel(input.guildId, input.channelId);
  assertDraftStatus(draft, ['SETUP', 'ACTIVE', 'COMPLETE']);

  const state = parseDraftState(draft);
  const status = draft.status as CaptainDraftStatus;
  const location = participantLocation(state, input.participantKey);

  if (location === 'missing') {
    throw new CaptainDraftError('Player not found in this draft.');
  }

  const nextState =
    location === 'pool'
      ? removeFromPool(state, input.participantKey)
      : removeFromTeam(state, input.participantKey);

  return persistAndRefresh(input.client, draft, status, nextState, state);
}

/** Mod: substitute one draft player for someone not already in the draft. */
export async function modReplacePlayer(input: {
  client: Client;
  guildId: string;
  channelId: string;
  outgoingKey: string;
  incoming: DraftParticipant;
}): Promise<CaptainDraft> {
  const draft = await loadActiveDraftForChannel(input.guildId, input.channelId);
  assertDraftStatus(draft, ['SETUP', 'ACTIVE', 'COMPLETE']);

  const state = parseDraftState(draft);
  assertPlayerNotInDraft(state, input.incoming);

  const nextState = replaceParticipant(state, input.outgoingKey, input.incoming);
  return persistAndRefresh(
    input.client,
    draft,
    draft.status as CaptainDraftStatus,
    nextState,
    state,
  );
}

/** Mod: swap two non-captain players across teams or team↔pool. */
export async function modSwapPlayers(input: {
  client: Client;
  guildId: string;
  channelId: string;
  keyA: string;
  keyB: string;
}): Promise<CaptainDraft> {
  const draft = await loadActiveDraftForChannel(input.guildId, input.channelId);
  assertDraftStatus(draft, ['ACTIVE', 'COMPLETE']);

  const state = parseDraftState(draft);
  const nextState = swapParticipants(state, input.keyA, input.keyB);
  return persistAndRefresh(
    input.client,
    draft,
    draft.status as CaptainDraftStatus,
    nextState,
    state,
  );
}

/** Mod: move a drafted player to another team. */
export async function modMovePlayer(input: {
  client: Client;
  guildId: string;
  channelId: string;
  participantKey: string;
  toCaptainKey: string;
}): Promise<CaptainDraft> {
  const draft = await loadActiveDraftForChannel(input.guildId, input.channelId);
  assertDraftStatus(draft, ['ACTIVE', 'COMPLETE']);

  const state = parseDraftState(draft);
  const nextState = moveParticipant(state, input.participantKey, input.toCaptainKey);
  return persistAndRefresh(
    input.client,
    draft,
    draft.status as CaptainDraftStatus,
    nextState,
    state,
  );
}

/** Mod: revert the last snake pick during ACTIVE. */
export async function modUndoPick(input: {
  client: Client;
  guildId: string;
  channelId: string;
}): Promise<CaptainDraft> {
  const draft = await loadActiveDraftForChannel(input.guildId, input.channelId);
  assertDraftStatus(draft, ['ACTIVE']);

  const state = parseDraftState(draft);
  const nextState = undoLastPick(state);
  return persistAndRefresh(input.client, draft, 'ACTIVE', nextState, state);
}

/** Mod: force-assign the current pick for an AFK captain. */
export async function modForcePick(input: {
  client: Client;
  guildId: string;
  channelId: string;
  participantKey: string;
}): Promise<CaptainDraft> {
  const draft = await loadActiveDraftForChannel(input.guildId, input.channelId);
  assertDraftStatus(draft, ['ACTIVE']);

  const state = parseDraftState(draft);
  const nextState = applyPick(state, input.participantKey);
  const nextStatus = nextStatusAfterMutation('ACTIVE', nextState);
  const saved = await saveDraftState(draft.id, nextStatus, nextState);

  if (saved.draftMessageId) {
    await syncLiveDraftMessage(input.client, saved, { previousState: state });
  }
  await refreshPublishedTeamsIfAny(input.client, saved);

  return saved;
}

/** Mod: rename any team display name after COMPLETE. */
export async function modRenameTeam(input: {
  client: Client;
  guildId: string;
  channelId: string;
  captainKey: string;
  name: string;
}): Promise<CaptainDraft> {
  const loaded = await loadActiveDraftForChannel(input.guildId, input.channelId);
  const loadedState = parseDraftState(loaded);
  const healedStatus = nextStatusAfterMutation(loaded.status as CaptainDraftStatus, loadedState);
  const draft =
    healedStatus === loaded.status
      ? loaded
      : await persistAndRefresh(
          input.client,
          loaded,
          loaded.status as CaptainDraftStatus,
          loadedState,
        );
  assertDraftStatus(draft, ['COMPLETE']);

  const state = parseDraftState(draft);
  const nextState = renameTeamInState(state, input.captainKey, input.name);
  const saved = await saveDraftState(draft.id, 'COMPLETE', nextState);

  await refreshPublishedTeamsIfAny(input.client, saved);
  return saved;
}
