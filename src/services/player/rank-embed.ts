import { EmbedBuilder } from 'discord.js';
import type { PlayerProfile, PlayerProfileHero } from './player-profile.js';

const RANK_GOLD = 0xf0b232;

export function formatHeroTable(heroes: PlayerProfileHero[]): string {
  if (heroes.length === 0) {
    return '_No hero games yet_';
  }

  const nameWidth = Math.max(...heroes.map((hero) => hero.name.length));
  const kiWidth = Math.max(...heroes.map((hero) => String(hero.ki).length));

  const lines = heroes.map((hero) => {
    const name = hero.name.padEnd(nameWidth, ' ');
    const ki = String(hero.ki).padStart(kiWidth, ' ');
    return `${name}  ${ki} · ${hero.matchesPlayed}`;
  });

  return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

export function buildRankEmbed(
  profile: PlayerProfile,
  options?: { avatarUrl?: string | null },
): EmbedBuilder {
  const record =
    profile.winRatePercent === null
      ? `${profile.wins}W · ${profile.losses}L`
      : `${profile.wins}W · ${profile.losses}L · ${profile.winRatePercent}% WR`;

  // Mentions only resolve in description/fields — Discord footers are plain text.
  const description = profile.discordId
    ? `${record}\n\nLinked · <@${profile.discordId}>`
    : record;

  const embed = new EmbedBuilder()
    .setColor(RANK_GOLD)
    .setAuthor({ name: profile.username })
    .setTitle(`Rank #${profile.rankPosition} · ${profile.globalKi} ki`)
    .setDescription(description)
    .addFields({ name: 'Heroes', value: formatHeroTable(profile.heroes) });

  if (options?.avatarUrl) {
    embed.setThumbnail(options.avatarUrl);
  }

  if (!profile.discordId) {
    embed.setFooter({ text: 'Not linked to Discord' });
  }

  return embed;
}
