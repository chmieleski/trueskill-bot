import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

export const RELEASE_CUSTOM_PREFIX = 'changelog:';

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const RELEASE_ACTIONS = ['edit', 'publish', 'dismiss', 'modal'] as const;
const DISCORD_FIELD_MAX = 1024;
const ELLIPSIS = '…';
const RANK_GOLD = 0xf0b232;

export type ReleaseCustomAction = (typeof RELEASE_ACTIONS)[number];
export type StaffReleaseStatus = 'draft' | 'published' | 'skipped';

const STATUS_TITLE: Record<StaffReleaseStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  skipped: 'Dismissed',
};

/**
 * Staff-card button custom id: `changelog:edit:1.4.0`.
 */
export function releaseButtonCustomId(
  action: 'edit' | 'publish' | 'dismiss',
  version: string,
): string {
  return `${RELEASE_CUSTOM_PREFIX}${action}:${version}`;
}

/**
 * Edit-modal custom id: `changelog:modal:1.4.0`.
 */
export function releaseModalCustomId(version: string): string {
  return `${RELEASE_CUSTOM_PREFIX}modal:${version}`;
}

/**
 * Parse a changelog button or modal custom id. Rejects prerelease and a `v` prefix.
 */
export function parseReleaseCustomId(
  customId: string,
): { action: ReleaseCustomAction; version: string } | null {
  const parts = customId.split(':');
  if (parts.length !== 3 || `${parts[0]}:` !== RELEASE_CUSTOM_PREFIX) {
    return null;
  }

  const action = parts[1];
  const version = parts[2]!;
  if (!isReleaseCustomAction(action) || !VERSION_PATTERN.test(version)) {
    return null;
  }

  return { action, version };
}

/**
 * Trim text to a Discord embed field limit. Truncated values end with `…`.
 */
export function truncateDiscordField(text: string, max = DISCORD_FIELD_MAX): string {
  if (text.length <= max) {
    return text;
  }
  const keep = Math.max(0, max - ELLIPSIS.length);
  return `${text.slice(0, keep)}${ELLIPSIS}`;
}

/**
 * Staff draft/published/dismissed card. Note fields are truncated to 1024 characters.
 */
export function buildStaffReleaseEmbed(input: {
  version: string;
  playerNotes: string;
  engineeringNotes: string;
  status: StaffReleaseStatus;
  publishedCount?: number;
  failures?: string[];
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(RANK_GOLD)
    .setTitle(`${STATUS_TITLE[input.status]} · v${input.version}`);

  if (typeof input.publishedCount === 'number') {
    embed.setDescription(`Posted to ${input.publishedCount} servers.`);
  }

  embed.addFields(
    {
      name: 'Player notes',
      value: discordFieldValue(input.playerNotes),
      inline: false,
    },
    {
      name: 'Engineering notes',
      value: discordFieldValue(input.engineeringNotes),
      inline: false,
    },
  );

  if (input.failures?.length) {
    embed.addFields({
      name: 'Failed',
      value: discordFieldValue(input.failures.join('\n')),
      inline: false,
    });
  }

  return embed;
}

/**
 * Player-facing changelog embed. `playerNotes` is already capped at 4000 characters.
 */
export function buildPlayerReleaseEmbed(input: {
  version: string;
  playerNotes: string;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(RANK_GOLD)
    .setTitle(`v${input.version}`)
    .setDescription(input.playerNotes);
}

/**
 * Edit / Publish / Dismiss row for drafts. Empty when the release is already closed.
 */
export function buildStaffReleaseButtons(
  version: string,
  status: StaffReleaseStatus = 'draft',
): ActionRowBuilder<ButtonBuilder>[] {
  if (status !== 'draft') {
    return [];
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(releaseButtonCustomId('edit', version))
      .setLabel('Edit')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(releaseButtonCustomId('publish', version))
      .setLabel('Publish')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(releaseButtonCustomId('dismiss', version))
      .setLabel('Dismiss')
      .setStyle(ButtonStyle.Danger),
  );

  return [row];
}

function isReleaseCustomAction(value: string | undefined): value is ReleaseCustomAction {
  return RELEASE_ACTIONS.some((action) => action === value);
}

/** Discord rejects empty field values; use a zero-width space when notes are blank. */
function discordFieldValue(text: string): string {
  return truncateDiscordField(text) || '\u200b';
}
