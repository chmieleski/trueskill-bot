import { EmbedBuilder } from 'discord.js';
import type { PlayerProfile, PlayerProfileHero } from './player-profile.js';
import type { TeammateStats } from './teammate-stats.js';
import { formatTeammateTable } from './teammate-stats.js';
import { CALIBRATING_LABEL, formatPublicKi, isCalibrating } from '../rating/rating-math.js';

const RANK_GOLD = 0xf0b232;

export function formatHeroTable(heroes: PlayerProfileHero[], leagueGames: number): string {
  if (heroes.length === 0) {
    return '_No hero games yet_';
  }

  const cells = heroes.map((hero) => {
    const record = `${hero.wins}W ${hero.losses}L`;
    const recordWithWr =
      hero.winRatePercent === null ? record : `${record} · ${hero.winRatePercent}%`;
    return {
      name: hero.name,
      ki: formatPublicKi(hero.ki, leagueGames),
      record: recordWithWr,
    };
  });
  const nameWidth = Math.max(...cells.map((cell) => cell.name.length));
  const kiWidth = Math.max(...cells.map((cell) => cell.ki.length));

  const lines = cells.map((cell) => {
    const name = cell.name.padEnd(nameWidth, ' ');
    const ki = cell.ki.padStart(kiWidth, ' ');
    return `${name}  ${ki} · ${cell.record}`;
  });

  return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

export function buildRankEmbed(
  profile: PlayerProfile,
  options?: {
    avatarUrl?: string | null;
    ratingLabel?: string;
    /** When false, never show the Heroes field (ACA / optional_in_game). Default true. */
    showHeroes?: boolean;
    teammates?: TeammateStats;
  },
): EmbedBuilder {
  const ratingLabel = options?.ratingLabel ?? 'ki';
  const showHeroes = options?.showHeroes !== false;
  const leagueGames = profile.wins + profile.losses;
  const title = isCalibrating(leagueGames)
    ? CALIBRATING_LABEL
    : `Rank #${profile.rankPosition} · ${profile.globalKi} ${ratingLabel}`;
  const record =
    profile.winRatePercent === null
      ? `${profile.wins}W · ${profile.losses}L · ${profile.quits}Q`
      : `${profile.wins}W · ${profile.losses}L · ${profile.quits}Q · ${profile.winRatePercent}% WR`;

  // Mentions only resolve in description/fields — Discord footers are plain text.
  const description = profile.discordId ? `${record}\n\nLinked · <@${profile.discordId}>` : record;

  const embed = new EmbedBuilder()
    .setColor(RANK_GOLD)
    .setAuthor({ name: profile.username })
    .setTitle(title)
    .setDescription(description);

  // Omit when empty (ACA has no hero ratings; UDBR players may also have none yet).
  if (showHeroes && profile.heroes.length > 0) {
    embed.addFields({
      name: 'Heroes',
      value: formatHeroTable(profile.heroes, leagueGames),
    });
  }

  if (options?.teammates) {
    const { playedWith, winWith, loseWith } = options.teammates;
    if (playedWith.length > 0) {
      embed.addFields({ name: 'Played with', value: formatTeammateTable(playedWith) });
    }
    if (winWith.length > 0) {
      embed.addFields({ name: 'Win with', value: formatTeammateTable(winWith) });
    }
    if (loseWith.length > 0) {
      embed.addFields({ name: 'Lose with', value: formatTeammateTable(loseWith) });
    }
  }

  if (options?.avatarUrl) {
    embed.setThumbnail(options.avatarUrl);
  }

  if (!profile.discordId) {
    embed.setFooter({ text: 'Not linked to Discord' });
  }

  return embed;
}
