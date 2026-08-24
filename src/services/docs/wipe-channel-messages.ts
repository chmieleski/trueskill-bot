import { Collection, type Message, type NewsChannel, type TextChannel } from 'discord.js';

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

/** Guild text or announcement channel that supports message bulk delete. */
type WipeChannel = TextChannel | NewsChannel;

/**
 * Delete all messages in a guild text/announcement channel.
 * Uses bulkDelete for messages younger than 14 days; older messages are deleted one-by-one.
 * @returns Number of messages deleted.
 */
export async function wipeChannelMessages(channel: WipeChannel): Promise<number> {
  let deleted = 0;

  for (;;) {
    const fetchedRaw = await channel.messages.fetch({ limit: 100 });
    if (fetchedRaw.size === 0) {
      break;
    }

    const fetched: Collection<string, Message> =
      fetchedRaw instanceof Collection
        ? fetchedRaw
        : new Collection(fetchedRaw as ReadonlyMap<string, Message>);

    const cutoff = Date.now() - TWO_WEEKS_MS;
    const recent = fetched.filter((message) => message.createdTimestamp > cutoff);
    const old = fetched.filter((message) => message.createdTimestamp <= cutoff);

    if (recent.size >= 2) {
      await channel.bulkDelete(recent, true);
      deleted += recent.size;
    } else {
      for (const message of recent.values()) {
        await message.delete();
        deleted += 1;
      }
    }

    for (const message of old.values()) {
      await message.delete();
      deleted += 1;
    }
  }

  return deleted;
}
