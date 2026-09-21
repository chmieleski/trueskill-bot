export interface Wc3statsMapInput {
  map?: string;
  path?: string;
  normalizedName?: string;
  sha1?: string;
}

export interface Wc3statsMapConfig {
  pattern: RegExp;
  sha1Allowlist: Set<string>;
}

/** True when the lobby matches the league map filter (name regex or map.sha1 allowlist). */
export function isWc3statsMap(input: Wc3statsMapInput, config: Wc3statsMapConfig): boolean {
  // Use GET /gamelist/{id} `map.sha1`, never the list item `hash`.
  const sha1 = input.sha1?.trim().toLowerCase();
  if (sha1 && config.sha1Allowlist.has(sha1)) {
    return true;
  }

  const haystack = [input.map, input.path, input.normalizedName]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .join('\n');

  return haystack !== '' && config.pattern.test(haystack);
}

/** @deprecated Use {@link isWc3statsMap}. */
export const isUdbrMap = isWc3statsMap;

/** Compile map filter from guild config strings. Throws if the pattern is not a valid regex. */
export function compileWc3statsMapConfig(
  patternSource: string,
  sha1Allowlist: string[],
): Wc3statsMapConfig {
  try {
    return {
      pattern: new RegExp(patternSource, 'i'),
      sha1Allowlist: new Set(sha1Allowlist),
    };
  } catch {
    throw new Error('wc3stats map pattern is not a valid regular expression.');
  }
}
