import { GuildMember, type ChatInputCommandInteraction } from 'discord.js';
import type { ResolvedGuildConfig } from '../guild/guild-config.js';
import { resolveGuildConfig } from '../guild/guild-config.js';
import { assertHasMatchModRole } from '../match/match-auth.js';
import { currentCaptainKey, findParticipant } from './draft-logic.js';
import type { DraftState } from './draft-types.js';
import { CaptainDraftError } from './draft-types.js';

/** Collect Discord role snowflakes from a slash interaction member. */
function memberRoleIds(interaction: { member: unknown }): string[] {
  const member = interaction.member;
  if (!(member instanceof GuildMember)) {
    return [];
  }

  return [...member.roles.cache.keys()];
}

/** Resolve role context for match-mod checks on captain-draft commands. */
export async function resolveModContext(interaction: ChatInputCommandInteraction): Promise<{
  memberRoleIds: string[];
  matchModRoleId: string | undefined;
}> {
  if (!interaction.guildId) {
    throw new CaptainDraftError('This command can only be used in a server.');
  }

  const config = await resolveGuildConfig(interaction.guildId);

  return {
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: config.matchModRoleId,
  };
}

/** Require match moderator role (or universal mod) for setup and mod actions. */
export function assertCaptainDraftMod(
  interaction: ChatInputCommandInteraction,
  guildConfig: ResolvedGuildConfig,
): void {
  assertHasMatchModRole({
    actorDiscordId: interaction.user.id,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: guildConfig.matchModRoleId,
  });
}

/** Require the actor to be the current snake-draft captain. */
export function assertCurrentCaptainPick(state: DraftState, actorDiscordId: string): void {
  const captainKey = currentCaptainKey(state);
  if (!captainKey) {
    throw new CaptainDraftError('The draft is not waiting for a pick.');
  }

  const captain = findParticipant(state, captainKey);
  if (!captain?.discordId) {
    throw new CaptainDraftError(
      'The current captain must pick via the slash command (not linked to Discord).',
    );
  }

  if (captain.discordId !== actorDiscordId) {
    throw new CaptainDraftError(`It is not your turn. ${captain.label} is on the clock.`);
  }
}

/** Require the actor to be the Discord-linked captain for a team rename. */
export function assertTeamCaptainRename(
  state: DraftState,
  actorDiscordId: string,
  captainKey: string,
): void {
  const team = state.teams.find((entry) => entry.captainKey === captainKey);
  if (!team) {
    throw new CaptainDraftError('Team not found.');
  }

  const captain = findParticipant(state, captainKey);
  if (!captain?.discordId) {
    throw new CaptainDraftError('Only Discord-linked captains can rename their team.');
  }

  if (captain.discordId !== actorDiscordId) {
    throw new CaptainDraftError('Only the team captain can rename this team.');
  }
}
