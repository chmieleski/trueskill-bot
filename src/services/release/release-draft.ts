import { prisma } from '../../lib/prisma.js';
import { extractChangelogSection, isPlaceholderVersion } from './changelog.js';

export async function ensureDraftForVersion(input: {
  version: string;
  changelogMarkdown: string;
}): Promise<'skipped_placeholder' | 'missing_notes' | 'exists' | 'created'> {
  if (isPlaceholderVersion(input.version)) {
    return 'skipped_placeholder';
  }

  const existing = await prisma.botRelease.findUnique({
    where: { version: input.version },
    select: { version: true },
  });
  if (existing) {
    return 'exists';
  }

  const notes = extractChangelogSection(input.changelogMarkdown, input.version);
  if (!notes) {
    return 'missing_notes';
  }

  await prisma.botRelease.create({
    data: {
      version: input.version,
      engineeringNotes: notes,
      playerNotes: notes,
      status: 'draft',
    },
  });
  return 'created';
}
