import { DocsServiceError } from './docs-errors.js';
import type { DiscordDocPost } from './load-discord-docs.js';
import type { DiscordDocsRenderContext } from './resolve-discord-docs-context.js';

const DISCORD_MESSAGE_LIMIT = 2000;
const CONDITIONAL_RE = /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

const CONTEXT_FLAGS: Array<keyof DiscordDocsRenderContext> = [
  'wc3stats',
  'hostPrompts',
  'playerClaim',
  'rankReset',
  'sideWinLoss',
  'heroLeaderboards',
  'slotBound',
];

/** Collapse extra blank lines after conditional blocks are removed. */
export function normalizeDiscordDocWhitespace(content: string): string {
  return content.replace(/\n{3,}/g, '\n\n').trim();
}

function contextFlagValues(context: DiscordDocsRenderContext): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const key of CONTEXT_FLAGS) {
    flags[key] = Boolean(context[key]);
  }
  return flags;
}

function contextPlaceholderValues(
  context: DiscordDocsRenderContext,
): Record<string, string | number> {
  return {
    team1: context.team1,
    team2: context.team2,
    team1Slots: context.team1Slots,
    team2Slots: context.team2Slots,
    ratingLabel: context.ratingLabel,
    gameName: context.gameDisplayName,
    leagueName: context.leagueName,
    slotCount: context.slotCount,
  };
}

/** Apply `{{#flag}}…{{/flag}}` blocks; flags must be boolean keys on the render context. */
export function applyDiscordDocConditionals(
  template: string,
  context: DiscordDocsRenderContext,
): string {
  const flags = contextFlagValues(context);
  return template.replace(CONDITIONAL_RE, (_, flag: string, body: string) => {
    if (!(flag in flags)) {
      throw new DocsServiceError(`Unknown docs conditional flag: ${flag}`);
    }
    return flags[flag] ? body : '';
  });
}

/** Replace `{{key}}` placeholders from the render context. */
export function applyDiscordDocPlaceholders(
  template: string,
  context: DiscordDocsRenderContext,
): string {
  const values = contextPlaceholderValues(context);
  return template.replace(PLACEHOLDER_RE, (_, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new DocsServiceError(`Unknown docs placeholder: ${key}`);
    }
    return String(value);
  });
}

/** Render one markdown template for a league-specific Discord post. */
export function renderDiscordDocContent(
  template: string,
  context: DiscordDocsRenderContext,
): string {
  let content = applyDiscordDocConditionals(template, context);
  content = applyDiscordDocPlaceholders(content, context);
  content = normalizeDiscordDocWhitespace(content);

  if (!content) {
    throw new DocsServiceError('Rendered Discord doc is empty.');
  }
  if (content.length > DISCORD_MESSAGE_LIMIT) {
    throw new DocsServiceError(
      `Rendered Discord doc exceeds ${DISCORD_MESSAGE_LIMIT} characters (${content.length}).`,
    );
  }

  return content;
}

/** Render loaded markdown posts with league context and enforce Discord size limits. */
export function renderDiscordDocPosts(
  posts: DiscordDocPost[],
  context: DiscordDocsRenderContext,
): DiscordDocPost[] {
  return posts.map((post) => ({
    filename: post.filename,
    content: renderDiscordDocContent(post.content, context),
  }));
}
