import type { Attachment } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { isImageAttachment, resolveMimeType } from './lobby-screenshot.js';

function attachment(partial: Partial<Attachment>): Attachment {
  return partial as Attachment;
}

describe('isImageAttachment', () => {
  it('accepts image content types', () => {
    expect(isImageAttachment(attachment({ contentType: 'image/png', name: 'lobby.bin' }))).toBe(
      true,
    );
  });

  it('accepts common image extensions when content type is missing', () => {
    expect(isImageAttachment(attachment({ name: 'lobby.PNG' }))).toBe(true);
    expect(isImageAttachment(attachment({ name: 'lobby.jpg' }))).toBe(true);
  });

  it('rejects non-image files', () => {
    expect(isImageAttachment(attachment({ name: 'notes.txt' }))).toBe(false);
  });
});

describe('resolveMimeType', () => {
  it('uses the attachment content type when present', () => {
    expect(
      resolveMimeType(attachment({ contentType: 'image/jpeg; charset=binary', name: 'x.bin' })),
    ).toBe('image/jpeg');
  });

  it('falls back to extension', () => {
    expect(resolveMimeType(attachment({ name: 'lobby.webp' }))).toBe('image/webp');
  });
});
