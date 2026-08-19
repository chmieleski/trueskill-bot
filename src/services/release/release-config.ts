import { prisma } from '../../lib/prisma.js';
import { ReleaseServiceError } from './errors.js';

export const DRAFT_CHANNEL_TAKEN =
  'A changelog draft channel is already set in another server. Clear it there first.';

export async function setChangelogChannel(guildId: string, channelId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, changelogChannelId: channelId },
    update: { changelogChannelId: channelId },
  });
}

export async function clearChangelogChannel(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId },
    update: { changelogChannelId: null },
  });
}

export async function setChangelogDraftChannel(guildId: string, channelId: string): Promise<void> {
  const other = await prisma.guildConfig.findFirst({
    where: {
      changelogDraftChannelId: { not: null },
      NOT: { guildId },
    },
    select: { guildId: true },
  });
  if (other) {
    throw new ReleaseServiceError(DRAFT_CHANNEL_TAKEN);
  }

  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId, changelogDraftChannelId: channelId },
    update: { changelogDraftChannelId: channelId },
  });
}

export async function clearChangelogDraftChannel(guildId: string): Promise<void> {
  await prisma.guildConfig.upsert({
    where: { guildId },
    create: { guildId },
    update: { changelogDraftChannelId: null },
  });
}

export async function findChangelogDraftChannel(): Promise<{
  guildId: string;
  channelId: string;
} | null> {
  const row = await prisma.guildConfig.findFirst({
    where: { changelogDraftChannelId: { not: null } },
    select: { guildId: true, changelogDraftChannelId: true },
  });
  if (!row?.changelogDraftChannelId) {
    return null;
  }
  return { guildId: row.guildId, channelId: row.changelogDraftChannelId };
}

export async function listPlayerChangelogChannels(): Promise<
  { guildId: string; channelId: string }[]
> {
  const rows = await prisma.guildConfig.findMany({
    where: { changelogChannelId: { not: null } },
    select: { guildId: true, changelogChannelId: true },
  });
  return rows.flatMap((row) =>
    row.changelogChannelId ? [{ guildId: row.guildId, channelId: row.changelogChannelId }] : [],
  );
}
