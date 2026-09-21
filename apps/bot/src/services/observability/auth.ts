import { extractBearerToken } from '../../api/auth.js';
import { isLoopbackBind } from '../../config/env.js';

/**
 * Decide whether an obs HTTP request is authorized.
 * Loopback: token optional (but must match if both configured and provided incorrectly).
 * Non-loopback: Bearer OBS_TOKEN required.
 */
export function authorizeObsRequest(input: {
  bind: string;
  configuredToken: string | undefined;
  authorizationHeader: string | undefined;
}): { ok: true } | { ok: false; status: 401; error: string } {
  const loopback = isLoopbackBind(input.bind);
  const provided = extractBearerToken(input.authorizationHeader);

  if (loopback) {
    if (input.configuredToken && provided !== null && provided !== input.configuredToken) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
    return { ok: true };
  }

  if (!input.configuredToken) {
    return { ok: false, status: 401, error: 'OBS_TOKEN is required when bind is not loopback' };
  }

  if (provided !== input.configuredToken) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  return { ok: true };
}
