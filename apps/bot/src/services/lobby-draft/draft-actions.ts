import {
  ChannelType,
  RESTJSONErrorCodes,
  ThreadAutoArchiveDuration,
  type Client,
} from 'discord.js';
import type { LobbyDraft } from '@dbz/db';
import type { GameProfile } from '../../domain/game-profile.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { getGameProfileForLeague } from '../league/league-profile.js';
import { resolveLeagueConfig } from '../league/league-wc3stats.js';
import { loadHeroSlotColorNames } from '../wc3stats/wc3stats-slot-map.js';
import { syncLobbyDiscordMessage } from '../lobby/discord-sync.js';
import { nickForDiscordId } from '../lobby/lobby-identity.js';
import { assertCanManageMatch } from '../match/match-auth.js';
import {
  getMatchByDiscordMessageId,
  MatchServiceError,
  replaceMatchRoster,
  requireLeagueId,
} from '../match/match-service.js';
import {
  applyPick,
  applySide,
  applyTimeout,
  assertCanStartLobbyDraft,
  assertOnClock,
  castVote,
  chooseCoin,
  clockChanged,
  findParticipant,
  heroIdsForSide,
  linkedParticipants,
  lockInHero,
  onClockCaptainKey,
  participantByDiscordId,
  removeParticipant,
  replaceParticipant,
  setHeroPrefs,
  teamOfKey,
} from './draft-logic.js';
import {
  findActiveLobbyDraftForMatch,
  loadLobbyDraftById,
  parseLobbyDraftState,
  saveLobbyDraftState,
  serializeLobbyDraftState,
} from './draft-state.js';
import { clearLobbyDraftTimer, scheduleLobbyDraftTimeout } from './draft-timer.js';
import {
  initialLobbyDraftState,
  LOBBY_DRAFT_PHASE_SECONDS,
  LobbyDraftConflictError,
  LobbyDraftError,
  NOT_IN_DRAFT_MESSAGE,
  participantKey,
  type CoinChoice,
  type LobbyDraftParticipant,
  type LobbyDraftState,
} from './draft-types.js';
import {
  buildLobbyDraftComponents,
  buildLobbyDraftEmbed,
  type LobbyDraftView,
} from './draft-ui.js';

const log = createLogger('lobby_draft');
const MAX_SAVE_ATTEMPTS = 5;

type ManageAuth = { actorDiscordId: string; memberRoleIds: string[]; matchModRoleId?: string };

function deadlineFor(phase: LobbyDraftState['phase']): string {
  return new Date(Date.now() + LOBBY_DRAFT_PHASE_SECONDS[phase] * 1000).toISOString();
}

async function loadView(profile: GameProfile): Promise<LobbyDraftView> {
  const heroes = await prisma.hero.findMany({ select: { id: true, name: true } });
  return { profile, heroNames: new Map(heroes.map((h) => [h.id, h.name])) };
}

/**
 * Hero/slot id → `w3_<color>` application emoji. Missing emojis are skipped, so the
 * roster still renders (without colors) before they are uploaded.
 */
async function loadSlotEmojis(client: Client, leagueId: string): Promise<Map<number, string>> {
  try {
    const [colors, emojis] = await Promise.all([
      loadHeroSlotColorNames(leagueId),
      client.application?.emojis.fetch(),
    ]);
    const byName = new Map(emojis?.map((e) => [e.name, e.toString()]));
    const result = new Map<number, string>();
    for (const [heroId, color] of colors) {
      const emoji = byName.get(`w3_${color}`);
      if (emoji) result.set(heroId, emoji);
    }
    return result;
  } catch (error) {
    log.warn({ err: error, leagueId }, 'Failed to load slot color emojis');
    return new Map();
  }
}

async function threadChannel(client: Client, threadId: string) {
  const channel = await client.channels.fetch(threadId).catch(() => null);
  return channel?.isThread() ? channel : null;
}

/** What the captain on the clock must do now (bold = the button to press). */
function clockAction(state: LobbyDraftState, teamNames: { 1: string; 2: string }): string {
  switch (state.phase) {
    case 'COIN_CHOICE':
      return 'choose **First pick** or **Pick side**';
    case 'SIDE':
      return `pick your side: **${teamNames[1]}** or **${teamNames[2]}**`;
    case 'PICK':
      return `**pick a player** (${state.pickIndex + 1}/${state.pickIndex + state.pool.length})`;
    default:
      return 'your turn';
  }
}

/** Post log lines added by a mutation, pinging whoever must act next. */
async function postUpdate(
  client: Client,
  draft: LobbyDraft,
  prev: LobbyDraftState,
  next: LobbyDraftState,
) {
  const profile = await getGameProfileForLeague(draft.leagueId);
  const heroNames = next.heroResult
    ? (await loadView(profile)).heroNames
    : new Map<number, string>();
  const lines = next.log
    .slice(prev.log.length)
    .map((l) => l.replace(/hero #(\d+)/g, (m0, id: string) => heroNames.get(Number(id)) ?? m0));
  const mentions: string[] = [];
  if (clockChanged(prev, next)) {
    const key = onClockCaptainKey(next);
    const id = key ? findParticipant(next, key)?.discordId : undefined;
    if (id) {
      mentions.push(id);
      lines.push(`👉 <@${id}> — ${clockAction(next, profile.teamNames)}`);
    } else if (next.phase === 'HERO' && prev.phase !== 'HERO' && !next.heroResult) {
      const ids = linkedParticipants(next).map((p) => p.discordId!);
      mentions.push(...ids);
      lines.push(`👉 ${ids.map((i) => `<@${i}>`).join(' ')} — press **Pick heroes**`);
    }
  }
  if (lines.length === 0) return;
  const thread = await threadChannel(client, draft.threadId);
  await thread
    ?.send({
      content: lines.join('\n').slice(0, 2000),
      allowedMentions: { users: mentions },
    })
    .catch((error: unknown) =>
      log.warn({ err: error, draftId: draft.id }, 'Failed to post draft update'),
    );
}

export async function syncLobbyDraftLiveMessage(client: Client, draftId: string): Promise<void> {
  const draft = await loadLobbyDraftById(draftId);
  if (!draft.liveMessageId) return;
  const state = parseLobbyDraftState(draft);
  const view = await loadView(await getGameProfileForLeague(draft.leagueId));
  if (state.heroResult) view.slotEmojis = await loadSlotEmojis(client, draft.leagueId);
  const payload = {
    embeds: [buildLobbyDraftEmbed(draft, state, view)],
    components: draft.status === 'ACTIVE' ? buildLobbyDraftComponents(draft.id, state, view) : [],
  };
  try {
    const thread = await threadChannel(client, draft.threadId);
    if (!thread) return;
    try {
      const message = await thread.messages.fetch(draft.liveMessageId);
      await message.edit(payload);
    } catch (error) {
      if ((error as { code?: number }).code !== RESTJSONErrorCodes.UnknownMessage) throw error;
      const fresh = await thread.send(payload);
      await prisma.lobbyDraft.update({ where: { id: draftId }, data: { liveMessageId: fresh.id } });
    }
  } catch (error) {
    log.warn({ err: error, draftId }, 'Failed to sync lobby draft live message');
  }
}

async function finalize(client: Client, draft: LobbyDraft, state: LobbyDraftState): Promise<void> {
  const players = state.participants.map((p) => ({
    slot: state.heroResult![p.key]!.heroId,
    nick: p.nick,
  }));
  let match;
  try {
    match = await replaceMatchRoster(draft.matchId, players, {
      markLobbyRosterAuthority: true,
      completeLobbyDraftId: draft.id,
    });
  } catch (error) {
    if (!(error instanceof MatchServiceError)) throw error;
    await cancelLobbyDraft(client, draft.id, error.message);
    return;
  }
  clearLobbyDraftTimer(draft.id);
  await syncLobbyDiscordMessage(client, match, 'pending').catch((error: unknown) =>
    log.warn({ err: error, draftId: draft.id }, 'Failed to sync lobby message after draft'),
  );
  await (
    await threadChannel(client, draft.threadId)
  )
    ?.send(
      match.discordMessageId && match.discordChannelId
        ? `✅ Lobby updated with the drafted teams and heroes: https://discord.com/channels/${draft.guildId}/${match.discordChannelId}/${match.discordMessageId}`
        : '✅ Lobby updated with the drafted teams and heroes.',
    )
    .catch((error: unknown) =>
      log.warn({ err: error, draftId: draft.id }, 'Failed to post draft completion'),
    );
}

/** Re-run finalize for an ACTIVE draft whose heroes were assigned but never applied. */
export async function finalizeLobbyDraft(client: Client, draftId: string): Promise<void> {
  const draft = await loadLobbyDraftById(draftId);
  if (draft.status !== 'ACTIVE') return;
  const state = parseLobbyDraftState(draft);
  if (!state.heroResult) return;
  await finalize(client, draft, state);
  await syncLobbyDraftLiveMessage(client, draftId);
}

/**
 * Load → mutate → optimistic save (retrying on conflict) → side effects.
 * `mutate` must be pure so it can be re-run on fresh state.
 */
async function mutateDraft(
  client: Client,
  draftId: string,
  mutate: (state: LobbyDraftState, profile: GameProfile, draft: LobbyDraft) => LobbyDraftState,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const draft = await loadLobbyDraftById(draftId);
    if (draft.status !== 'ACTIVE') {
      throw new LobbyDraftError('This draft is no longer active.');
    }
    const prev = parseLobbyDraftState(draft);
    const profile = await getGameProfileForLeague(draft.leagueId);
    let next = mutate(prev, profile, draft);
    if (next.heroResult) {
      next = { ...next, deadlineAt: null };
    } else if (clockChanged(prev, next)) {
      next = { ...next, deadlineAt: deadlineFor(next.phase) };
    }

    let saved: LobbyDraft;
    try {
      saved = await saveLobbyDraftState(draft, next);
    } catch (error) {
      if (error instanceof LobbyDraftConflictError && attempt < MAX_SAVE_ATTEMPTS) continue;
      throw error;
    }

    await postUpdate(client, saved, prev, next);
    if (next.heroResult) {
      await finalize(client, saved, next);
    } else {
      scheduleLobbyDraftTimeout(client, saved.id, next.deadlineAt);
    }
    await syncLobbyDraftLiveMessage(client, saved.id);
    return;
  }
}

async function assertCanManageDraft(draftId: string, auth: ManageAuth): Promise<LobbyDraft> {
  const draft = await loadLobbyDraftById(draftId);
  assertCanManageMatch({ hostDiscordId: draft.hostDiscordId, ...auth });
  return draft;
}

export async function startLobbyDraft(
  input: {
    client: Client;
    messageId: string;
  } & ManageAuth,
): Promise<LobbyDraft> {
  const match = await getMatchByDiscordMessageId(input.messageId);
  if (!match || match.status !== 'PENDING' || !match.discordMessageId) {
    throw new MatchServiceError('This match can no longer be edited.');
  }
  const leagueId = requireLeagueId(match);
  assertCanManageMatch({ hostDiscordId: match.hostDiscordId, ...input });
  if (!(await resolveLeagueConfig(leagueId)).lobbyCaptainDraftEnabled) {
    throw new LobbyDraftError('Captain draft is disabled for this league.');
  }
  const profile = await getGameProfileForLeague(leagueId);
  if (profile.heroBinding !== 'slot_bound') {
    throw new LobbyDraftError('Captain draft is not available for this game.');
  }
  if (await findActiveLobbyDraftForMatch(match.id)) {
    throw new LobbyDraftError('A captain draft is already running for this lobby.');
  }
  const participants: LobbyDraftParticipant[] = match.players.map((mp) => ({
    key: participantKey(mp.player.username),
    nick: mp.player.username,
    ...(mp.player.discordId ? { discordId: mp.player.discordId } : {}),
  }));
  assertCanStartLobbyDraft(participants);
  const state = initialLobbyDraftState(participants, deadlineFor('VOTE'));

  const channel = await input.client.channels.fetch(match.discordChannelId);
  if (channel?.type !== ChannelType.GuildText && channel?.type !== ChannelType.GuildAnnouncement) {
    throw new LobbyDraftError('Cannot open a thread in this channel.');
  }
  const thread = await channel.threads.create({
    name: `Draft – lobby ${match.id.slice(-6)}`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
    reason: 'Lobby captain draft',
  });

  let draft: LobbyDraft;
  try {
    draft = await prisma.$transaction(async (tx) => {
      // Serialize concurrent starts for the same match (released at commit).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${match.id}))`;
      if (await tx.lobbyDraft.findFirst({ where: { matchId: match.id, status: 'ACTIVE' } })) {
        throw new LobbyDraftError('A captain draft is already running for this lobby.');
      }
      return tx.lobbyDraft.create({
        data: {
          guildId: thread.guildId,
          leagueId,
          matchId: match.id,
          parentChannelId: channel.id,
          threadId: thread.id,
          hostDiscordId: match.hostDiscordId,
          status: 'ACTIVE',
          state: serializeLobbyDraftState(state),
        },
      });
    });
  } catch (error) {
    await thread.delete().catch(() => undefined);
    throw error;
  }

  try {
    const view = await loadView(profile);
    const linkedIds = linkedParticipants(state).map((p) => p.discordId!);
    const unlinked = state.participants.filter((p) => !p.discordId).map((p) => `\`${p.nick}\``);
    const live = await thread.send({
      content: [
        `⚔️ Captain draft for this lobby. ${linkedIds.map((id) => `<@${id}>`).join(' ')}`,
        unlinked.length ? `Unlinked: ${unlinked.join(', ')}` : '',
        'The lobby is frozen until the draft ends or is cancelled.',
      ]
        .filter(Boolean)
        .join('\n'),
      embeds: [buildLobbyDraftEmbed(draft, state, view)],
      components: buildLobbyDraftComponents(draft.id, state, view),
      allowedMentions: { users: linkedIds },
    });
    draft = await prisma.lobbyDraft.update({
      where: { id: draft.id },
      data: { liveMessageId: live.id },
    });
    scheduleLobbyDraftTimeout(input.client, draft.id, state.deadlineAt);
  } catch (error) {
    await cancelLobbyDraft(input.client, draft.id, 'the draft could not be set up.').catch(
      (cancelError: unknown) =>
        log.warn({ err: cancelError, draftId: draft.id }, 'Failed to roll back draft setup'),
    );
    throw error;
  }
  log.info({ draftId: draft.id, matchId: match.id }, 'Lobby captain draft started');
  return draft;
}

type ActorInput = { client: Client; draftId: string; actorDiscordId: string };

export function voteCaptains(input: ActorInput & { keys: string[] }): Promise<void> {
  return mutateDraft(input.client, input.draftId, (s) =>
    castVote(s, input.actorDiscordId, input.keys),
  );
}

export function chooseCoinOption(input: ActorInput & { choice: CoinChoice }): Promise<void> {
  return mutateDraft(input.client, input.draftId, (s) => {
    assertOnClock(s, input.actorDiscordId);
    return chooseCoin(s, input.choice);
  });
}

export function pickPlayer(input: ActorInput & { key: string }): Promise<void> {
  return mutateDraft(input.client, input.draftId, (s) => {
    assertOnClock(s, input.actorDiscordId);
    return applyPick(s, input.key);
  });
}

export function chooseSide(input: ActorInput & { side: 1 | 2 }): Promise<void> {
  return mutateDraft(input.client, input.draftId, (s, profile) => {
    assertOnClock(s, input.actorDiscordId);
    return applySide(s, input.side, profile.teamNames);
  });
}

export function setHeroPreferences(input: ActorInput & { heroIds: number[] }): Promise<void> {
  return mutateDraft(input.client, input.draftId, (s, profile) =>
    setHeroPrefs(s, input.actorDiscordId, input.heroIds, profile),
  );
}

export function lockInHeroes(input: ActorInput): Promise<void> {
  return mutateDraft(input.client, input.draftId, (s, profile) =>
    lockInHero(s, input.actorDiscordId, profile),
  );
}

export async function manageRemove(
  input: ActorInput & ManageAuth & { key: string },
): Promise<void> {
  await assertCanManageDraft(input.draftId, input);
  return mutateDraft(input.client, input.draftId, (s, profile) =>
    removeParticipant(s, input.key, profile),
  );
}

/** Resolve "@mention / user id / nick" into a draft participant for this game. */
export async function resolveIncomingParticipant(
  gameId: string,
  raw: string,
): Promise<LobbyDraftParticipant> {
  const text = raw.trim();
  const discordId =
    /^<@!?(\d{17,20})>$/.exec(text)?.[1] ?? (/^\d{17,20}$/.test(text) ? text : null);
  if (discordId) {
    const nick = await nickForDiscordId(discordId, gameId);
    return { key: participantKey(nick), nick, discordId };
  }
  if (!text) {
    throw new LobbyDraftError('Enter a Discord @mention, user ID, or in-game nick.');
  }
  if (text.length > 32) throw new LobbyDraftError('That name is too long (max 32 characters).');
  const player = await prisma.player.findUnique({
    where: { gameId_username: { gameId, username: participantKey(text) } },
  });
  const nick = player?.username ?? text;
  return {
    key: participantKey(nick),
    nick,
    ...(player?.discordId ? { discordId: player.discordId } : {}),
  };
}

export async function manageReplace(
  input: ActorInput & ManageAuth & { key: string; who: string },
): Promise<void> {
  const draft = await assertCanManageDraft(input.draftId, input);
  const profile = await getGameProfileForLeague(draft.leagueId);
  const incoming = await resolveIncomingParticipant(profile.gameId, input.who);
  await mutateDraft(input.client, input.draftId, (s, p) =>
    replaceParticipant(s, input.key, incoming, p),
  );
  if (incoming.discordId) {
    await (
      await threadChannel(input.client, draft.threadId)
    )
      ?.send({
        content: `<@${incoming.discordId}> you joined this captain draft.`,
        allowedMentions: { users: [incoming.discordId] },
      })
      .catch((error: unknown) =>
        log.warn({ err: error, draftId: draft.id }, 'Failed to post join notice'),
      );
  }
}

/** Cancel without auth (lobby lifecycle, finalize failure). Lobby roster is untouched. */
export async function cancelLobbyDraft(
  client: Client,
  draftId: string,
  reason: string,
): Promise<void> {
  const { count } = await prisma.lobbyDraft.updateMany({
    where: { id: draftId, status: 'ACTIVE' },
    data: { status: 'CANCELLED' },
  });
  if (count === 0) return;
  clearLobbyDraftTimer(draftId);
  await syncLobbyDraftLiveMessage(client, draftId);
  const draft = await loadLobbyDraftById(draftId);
  const thread = await threadChannel(client, draft.threadId);
  await thread
    ?.send(`🚫 Draft cancelled: ${reason} The lobby can be edited again.`)
    .catch((error: unknown) => log.warn({ err: error, draftId }, 'Failed to post cancel notice'));
  await thread
    ?.setLocked(true)
    .catch((error: unknown) => log.warn({ err: error, draftId }, 'Failed to lock draft thread'));
}

export async function cancelLobbyDraftByUser(input: ActorInput & ManageAuth): Promise<void> {
  const draft = await assertCanManageDraft(input.draftId, input);
  if (draft.status !== 'ACTIVE') {
    throw new LobbyDraftError('This draft is no longer active.');
  }
  await cancelLobbyDraft(input.client, draft.id, `cancelled by <@${input.actorDiscordId}>.`);
}

export async function cancelActiveLobbyDraftForMatch(
  client: Client,
  matchId: string,
  reason: string,
): Promise<void> {
  const draft = await findActiveLobbyDraftForMatch(matchId);
  if (draft) await cancelLobbyDraft(client, draft.id, reason);
}

/** Timer path — no auth. Ignores early fires (rescheduled deadlines). */
export async function applyLobbyDraftTimeout(input: {
  client: Client;
  draftId: string;
}): Promise<void> {
  const draft = await loadLobbyDraftById(input.draftId);
  if (draft.status !== 'ACTIVE') return;
  const { deadlineAt } = parseLobbyDraftState(draft);
  if (deadlineAt && Date.now() + 50 < new Date(deadlineAt).getTime()) {
    scheduleLobbyDraftTimeout(input.client, draft.id, deadlineAt);
    return;
  }
  await mutateDraft(input.client, input.draftId, (s, profile) =>
    s.deadlineAt === deadlineAt ? applyTimeout(s, profile) : s,
  );
}

export async function getVoteMenuForActor(
  draftId: string,
  actorDiscordId: string,
): Promise<LobbyDraftState> {
  const draft = await loadLobbyDraftById(draftId);
  if (draft.status !== 'ACTIVE') throw new LobbyDraftError('This draft is no longer active.');
  const state = parseLobbyDraftState(draft);
  if (state.phase !== 'VOTE') throw new LobbyDraftError('Voting is closed.');
  if (!participantByDiscordId(state, actorDiscordId))
    throw new LobbyDraftError(NOT_IN_DRAFT_MESSAGE);
  return state;
}

export async function getHeroMenuForActor(
  draftId: string,
  actorDiscordId: string,
): Promise<{ heroes: Array<{ id: number; name: string }>; current: number[] }> {
  const draft = await loadLobbyDraftById(draftId);
  if (draft.status !== 'ACTIVE') throw new LobbyDraftError('This draft is no longer active.');
  const state = parseLobbyDraftState(draft);
  const actor = participantByDiscordId(state, actorDiscordId);
  const t = actor ? teamOfKey(state, actor.key) : null;
  const side = t === null ? null : state.teams![t].side;
  if (state.phase !== 'HERO' || !actor || !side) throw new LobbyDraftError(NOT_IN_DRAFT_MESSAGE);
  const ids = heroIdsForSide(await getGameProfileForLeague(draft.leagueId), side);
  const heroes = await prisma.hero.findMany({
    where: { id: { in: ids } },
    orderBy: { id: 'asc' },
    select: { id: true, name: true },
  });
  return { heroes, current: state.heroPrefs[actor.key] ?? [] };
}

export async function getManageMenuForActor(
  draftId: string,
  auth: ManageAuth,
): Promise<LobbyDraftState> {
  return parseLobbyDraftState(await assertCanManageDraft(draftId, auth));
}
