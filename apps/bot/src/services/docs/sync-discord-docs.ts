import type { GuildTextBasedChannel, NewsChannel, TextChannel } from 'discord.js';
import { loadDiscordDocs, type DiscordDocsKind } from './load-discord-docs.js';
import { renderDiscordDocPosts } from './render-discord-docs.js';
import type { DiscordDocsRenderContext } from './resolve-discord-docs-context.js';
import { wipeChannelMessages } from './wipe-channel-messages.js';

export type SyncDiscordDocsResult = {
  kind: DiscordDocsKind;
  deletedCount: number;
  postedCount: number;
  filenames: string[];
};

/**
 * Validate docs, wipe the channel, then post each guide message in filename order.
 */
export async function syncDiscordDocsToChannel(input: {
  kind: DiscordDocsKind;
  channel: GuildTextBasedChannel;
  context: DiscordDocsRenderContext;
  rootDir?: string;
}): Promise<SyncDiscordDocsResult> {
  const templates = loadDiscordDocs(input.kind, input.rootDir);
  const posts = renderDiscordDocPosts(templates, input.context);
  const deletedCount = await wipeChannelMessages(input.channel as TextChannel | NewsChannel);

  let postedCount = 0;
  for (const post of posts) {
    await input.channel.send({ content: post.content });
    postedCount += 1;
  }

  return {
    kind: input.kind,
    deletedCount,
    postedCount,
    filenames: posts.map((p) => p.filename),
  };
}
