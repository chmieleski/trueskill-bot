export type RegisterLobbySource =
  | { kind: 'empty' }
  | { kind: 'screenshot'; url: string; mimeType: string };

/**
 * Decide whether /register_lobby should OCR a screenshot or start empty.
 * wc3stats import is out of scope for Phase 1.
 */
export function resolveRegisterLobbySource(input: {
  attachmentUrl?: string | null;
  mimeType?: string | null;
}): RegisterLobbySource {
  const url = input.attachmentUrl?.trim() ?? '';
  if (url === '') {
    return { kind: 'empty' };
  }

  return {
    kind: 'screenshot',
    url,
    mimeType: input.mimeType?.trim() || 'image/png',
  };
}
