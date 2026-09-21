import type { CaptainDraft } from '@dbz/db';
import { randomUUID } from 'node:crypto';
import type { Guild } from 'discord.js';
import { prisma } from '../../lib/prisma.js';
import { parseDraftState } from '../captain-draft/draft-state.js';
import type { DraftParticipant, DraftState } from '../captain-draft/draft-types.js';
import { resolveParticipantsFromInput } from '../captain-draft/draft-resolve.js';
import {
  HERO_DRAFT_MIN_POOL_SIZE,
  HeroDraftError,
  type HeroDraftMember,
  type HeroDraftTeam,
  type HeroDraftTeamSide,
  type HeroPoolEntry,
} from './draft-types.js';

function toHeroMember(participant: DraftParticipant): HeroDraftMember {
  return participant.discordId
    ? { key: participant.key, label: participant.label, discordId: participant.discordId }
    : { key: participant.key, label: participant.label };
}

/** Build a hero-draft team from a completed captain-draft team. */
export function teamFromCaptainDraftTeam(
  state: DraftState,
  captainKey: string,
  side: HeroDraftTeamSide,
): HeroDraftTeam {
  const team = state.teams.find((entry) => entry.captainKey === captainKey);
  if (!team) {
    throw new HeroDraftError(`Captain draft team not found for key ${captainKey}.`);
  }
  const captain =
    team.roster.find((member) => member.key === team.captainKey) ??
    state.captains.find((member) => member.key === team.captainKey);
  if (!captain) {
    throw new HeroDraftError('Captain draft team is missing its captain.');
  }
  if (!captain.discordId) {
    throw new HeroDraftError(
      `Captain ${captain.label} is not linked to Discord. Link them before starting a hero draft.`,
    );
  }

  return {
    side,
    displayName: team.displayName,
    captain: toHeroMember(captain),
    roster: team.roster.map(toHeroMember),
    bans: [],
    picks: [],
  };
}

/** List completed captain drafts in a guild for autocomplete. */
export async function listCompletableCaptainDrafts(
  guildId: string,
  limit = 25,
): Promise<CaptainDraft[]> {
  return prisma.captainDraft.findMany({
    where: { guildId, status: 'COMPLETE' },
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
}

export async function loadCompletedCaptainDraft(draftId: string): Promise<{
  draft: CaptainDraft;
  state: DraftState;
}> {
  const draft = await prisma.captainDraft.findUnique({ where: { id: draftId } });
  if (!draft) {
    throw new HeroDraftError('Captain draft not found.');
  }
  if (draft.status !== 'COMPLETE') {
    throw new HeroDraftError('Captain draft must be COMPLETE to import teams.');
  }
  return { draft, state: parseDraftState(draft) };
}

/** Resolve a manual team: captain mention/name + optional roster string. */
export async function resolveManualTeam(input: {
  guild: Guild;
  gameId: string;
  side: HeroDraftTeamSide;
  captainInput: string;
  rosterInput?: string | null;
  displayName?: string | null;
}): Promise<HeroDraftTeam> {
  const captains = await resolveParticipantsFromInput({
    guild: input.guild,
    gameId: input.gameId,
    raw: input.captainInput,
  });
  if (captains.length !== 1) {
    throw new HeroDraftError('Provide exactly one captain for a manual team.');
  }
  const captain = captains[0]!;
  if (!captain.discordId) {
    throw new HeroDraftError(
      `Captain ${captain.label} is not linked to Discord. Link them before starting a hero draft.`,
    );
  }

  let roster: HeroDraftMember[] = [toHeroMember(captain)];
  if (input.rosterInput?.trim()) {
    const members = await resolveParticipantsFromInput({
      guild: input.guild,
      gameId: input.gameId,
      raw: input.rosterInput,
    });
    const seen = new Set<string>([captain.key]);
    for (const member of members) {
      const key = member.discordId ?? member.key;
      if (seen.has(member.key) || (member.discordId && seen.has(member.discordId))) {
        continue;
      }
      seen.add(member.key);
      if (member.discordId) {
        seen.add(member.discordId);
      }
      roster.push(toHeroMember(member));
    }
  }

  return {
    side: input.side,
    displayName: input.displayName?.trim() || `Team ${captain.label}`,
    captain: toHeroMember(captain),
    roster,
    bans: [],
    picks: [],
  };
}

/** Load GameHero snapshot for a game; refuse if below minimum size. */
export async function snapshotGameHeroPool(gameId: string): Promise<HeroPoolEntry[]> {
  const rows = await prisma.gameHero.findMany({
    where: { gameId },
    orderBy: { name: 'asc' },
    select: { objectId: true, name: true },
  });

  if (rows.length < HERO_DRAFT_MIN_POOL_SIZE) {
    throw new HeroDraftError(
      `Hero catalog needs at least ${HERO_DRAFT_MIN_POOL_SIZE} heroes (found ${rows.length}). Play more WOS matches or wait for catalog growth.`,
    );
  }

  return rows.map((row) => ({ objectId: row.objectId, name: row.name }));
}

/** Stable key helper for tests / manual construction. */
export function makeMemberKey(): string {
  return randomUUID();
}
