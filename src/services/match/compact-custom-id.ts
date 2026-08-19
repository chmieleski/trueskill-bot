const UUID_HYPHENATED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT = /^[0-9a-f]{32}$/i;

/** Strip UUID hyphens so ids + snowflake fit Discord's 100-char customId. */
export function compactUuidForCustomId(id: string): string {
  return UUID_HYPHENATED.test(id) ? id.replace(/-/g, '') : id;
}

/** Restore hyphenated UUID form for Prisma lookups. */
export function expandUuidFromCustomId(id: string): string {
  if (!UUID_COMPACT.test(id)) {
    return id;
  }
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
