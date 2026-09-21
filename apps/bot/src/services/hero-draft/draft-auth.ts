import { GuildMember, type ChatInputCommandInteraction } from 'discord.js';
import type { ResolvedGuildConfig } from '../guild/guild-config.js';
import { assertHasMatchModRole } from '../match/match-auth.js';
import { currentTurn, teamBySide } from './draft-logic.js';
import { HeroDraftError, type HeroDraftState } from './draft-types.js';

function memberRoleIds(interaction: { member: unknown }): string[] {
  const member = interaction.member;
  if (!(member instanceof GuildMember)) {
    return [];
  }
  return [...member.roles.cache.keys()];
}

/** Require match moderator role for hero-draft setup/cancel. */
export function assertHeroDraftMod(
  interaction: ChatInputCommandInteraction,
  guildConfig: ResolvedGuildConfig,
): void {
  assertHasMatchModRole({
    actorDiscordId: interaction.user.id,
    memberRoleIds: memberRoleIds(interaction),
    matchModRoleId: guildConfig.matchModRoleId,
  });
}

/** Require the Discord-linked captain currently on the clock. */
export function assertOnClockCaptain(state: HeroDraftState, actorDiscordId: string): void {
  const turn = currentTurn(state);
  if (!turn) {
    throw new HeroDraftError('The draft is not waiting for an action.');
  }
  const team = teamBySide(state, turn.team);
  if (!team.captain.discordId) {
    throw new HeroDraftError(
      'The current captain is not linked to Discord. A moderator must cancel and restart with a linked captain.',
    );
  }
  if (team.captain.discordId !== actorDiscordId) {
    throw new HeroDraftError(`It is not your turn. ${team.captain.label} is on the clock.`);
  }
}
