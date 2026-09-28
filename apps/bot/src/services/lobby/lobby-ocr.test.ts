import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const generateContent = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

vi.mock('../../config/env.js', () => ({
  env: { geminiApiKey: 'test-key' },
}));

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
  }),
}));

import {
  extractLobbyPlayers,
  isGeminiCapacityError,
  GEMINI_OCR_FALLBACK_MODEL,
  GEMINI_OCR_PRIMARY_MODEL,
} from './lobby-ocr.js';

describe('isGeminiCapacityError', () => {
  it('detects 503 status', () => {
    expect(isGeminiCapacityError({ status: 503, message: 'busy' })).toBe(true);
  });

  it('detects UNAVAILABLE payload in message', () => {
    expect(
      isGeminiCapacityError({
        message: '{"error":{"code":503,"message":"high demand","status":"UNAVAILABLE"}}',
      }),
    ).toBe(true);
  });

  it('ignores other errors', () => {
    expect(isGeminiCapacityError({ status: 400, message: 'bad request' })).toBe(false);
    expect(isGeminiCapacityError(new Error('network'))).toBe(false);
    expect(isGeminiCapacityError(null)).toBe(false);
  });
});

describe('extractLobbyPlayers capacity fallback', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    generateContent.mockReset();
    globalThis.fetch = vi.fn(async () =>
      Response.json(undefined, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    ) as typeof fetch;
    // Provide a tiny PNG-like body
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('retries with backup model when primary returns 503', async () => {
    const capacityError = Object.assign(new Error('high demand'), { status: 503 });
    generateContent.mockRejectedValueOnce(capacityError).mockResolvedValueOnce({
      text: JSON.stringify({
        players: [
          { slot: 1, nick: 'Goku' },
          { slot: 7, nick: 'Vegeta' },
        ],
      }),
    });

    const players = await extractLobbyPlayers('https://cdn.example/lobby.png', 'image/png');

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(generateContent.mock.calls[0]![0].model).toBe(GEMINI_OCR_PRIMARY_MODEL);
    expect(generateContent.mock.calls[1]![0].model).toBe(GEMINI_OCR_FALLBACK_MODEL);
    expect(players).toEqual([
      { slot: 1, nick: 'goku' },
      { slot: 7, nick: 'vegeta' },
    ]);
  });

  it('does not fall back on non-capacity errors', async () => {
    generateContent.mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }));

    await expect(extractLobbyPlayers('https://cdn.example/lobby.png', 'image/png')).rejects.toThrow(
      'Lobby OCR failed. Please try again in a moment.',
    );
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(generateContent.mock.calls[0]![0].model).toBe(GEMINI_OCR_PRIMARY_MODEL);
  });
});
