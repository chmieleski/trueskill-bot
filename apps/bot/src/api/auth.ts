/**
 * Extract the Bearer token from an Authorization header value.
 * Returns null when the header is missing or not Bearer-shaped.
 */
export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  if (authorizationHeader === undefined) {
    return null;
  }

  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorizationHeader.trim());
  if (!match) {
    return null;
  }

  const token = match[1];
  return token.length > 0 ? token : null;
}
