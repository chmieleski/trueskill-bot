import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env.js';
import { createLogger } from '../../lib/logger.js';
import { normalizeNick } from '../player/player-nick.js';
import { teamDisplayName } from '../guild/team-names.js';

const log = createLogger('lobby-ocr');

export interface LobbyPlayer {
  slot: number;
  nick: string;
  /** Soft lock for balance hints + shuffle; omitted/false = unlocked. */
  locked?: boolean;
  /** Quitter flag when creating a roster; host/mods set via report flow. */
  isQuitter?: boolean;
}

export interface ValidatedLobby {
  teamA: LobbyPlayer[];
  teamB: LobbyPlayer[];
}

/** User-facing English errors safe to show in Discord replies. */
export class LobbyOcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LobbyOcrError';
  }
}

const LOBBY_OCR_SYSTEM_INSTRUCTION =
  'Você é um extrator de dados OCR focado na tela de lobby do jogo Warcraft III. A tela apresenta uma lista vertical que sempre contém exatamente 12 posições (slots), lidas de cima para baixo. Regras: 1. Slots de 1 a 6 são da Equipe A. Slots de 7 a 12 são da Equipe B. 2. Ignore slots escritos \'Open\', \'Closed\' ou \'Computer\'. 3. Extraia apenas nicks de jogadores humanos, associando-os ao número do slot absoluto (linha da tela de 1 a 12). Retorne APENAS JSON no formato: { "players": [ { "slot": 1, "nick": "Nome" } ] }';

const MIN_SLOT = 1;
const MAX_SLOT = 12;
const TEAM_A_MAX_SLOT = 6;
const GEMINI_MODEL = 'gemini-3.1-flash-lite';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePlayersPayload(raw: string): LobbyPlayer[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.warn({ err: error, rawPreview: raw.slice(0, 200) }, 'OCR JSON parse failed');
    throw new LobbyOcrError(
      'Could not parse the lobby screenshot. Please try again with a clearer image.',
    );
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.players)) {
    log.warn({ parsedType: typeof parsed }, 'OCR payload missing players array');
    throw new LobbyOcrError(
      'Could not parse the lobby screenshot. Please try again with a clearer image.',
    );
  }

  const players: LobbyPlayer[] = [];

  for (const entry of parsed.players) {
    if (!isRecord(entry)) {
      log.warn({ entry }, 'OCR player entry is not an object');
      throw new LobbyOcrError(
        'Could not parse the lobby screenshot. Please try again with a clearer image.',
      );
    }

    const slot = typeof entry.slot === 'number' ? entry.slot : Number(entry.slot);
    const nick = typeof entry.nick === 'string' ? entry.nick : '';

    const cleanedNick = normalizeNick(nick);

    if (!Number.isInteger(slot) || cleanedNick === '') {
      log.warn({ slot, nick }, 'OCR player entry invalid');
      throw new LobbyOcrError(
        'Could not parse the lobby screenshot. Please try again with a clearer image.',
      );
    }

    players.push({
      slot,
      nick: cleanedNick,
    });
  }

  log.verbose({ playerCount: players.length }, 'Parsed OCR players payload');
  return players;
}

/**
 * Fetch a Discord attachment image and extract human lobby players via Gemini vision OCR.
 */
export async function extractLobbyPlayers(
  imageUrl: string,
  mimeType: string,
): Promise<LobbyPlayer[]> {
  log.debug({ mimeType }, 'Downloading lobby screenshot');
  const startedAt = Date.now();
  const imageResponse = await fetch(imageUrl);

  if (!imageResponse.ok) {
    log.error(
      { status: imageResponse.status, statusText: imageResponse.statusText },
      'Failed to download lobby screenshot',
    );
    throw new LobbyOcrError('Could not download the lobby screenshot. Please try again.');
  }

  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  const base64Image = imageBuffer.toString('base64');
  log.debug(
    { bytes: imageBuffer.byteLength, downloadMs: Date.now() - startedAt },
    'Screenshot downloaded',
  );

  const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });
  const ocrStartedAt = Date.now();

  let response;

  try {
    log.info({ model: GEMINI_MODEL, mimeType }, 'Calling Gemini lobby OCR');
    response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          inlineData: {
            data: base64Image,
            mimeType,
          },
        },
        'Extract the lobby players as JSON.',
      ],
      config: {
        systemInstruction: LOBBY_OCR_SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
      },
    });
  } catch (error) {
    log.error(
      { err: error, model: GEMINI_MODEL, ocrMs: Date.now() - ocrStartedAt },
      'Gemini lobby OCR request failed',
    );
    throw new LobbyOcrError('Lobby OCR failed. Please try again in a moment.');
  }

  const text = response.text;
  log.debug(
    { ocrMs: Date.now() - ocrStartedAt, responseChars: text?.length ?? 0 },
    'Gemini OCR response received',
  );

  if (!text) {
    log.warn('Gemini OCR returned empty text');
    throw new LobbyOcrError(
      'Could not read the lobby screenshot. Please try again with a clearer image.',
    );
  }

  log.verbose({ rawPreview: text.slice(0, 300) }, 'Gemini OCR raw text');
  return parsePlayersPayload(text);
}

/**
 * Validate OCR output: slots 1–12, no duplicates, both teams non-empty.
 * Team A = slots 1–6; Team B = slots 7–12. Unbalanced fills are allowed.
 * Slot number implies heroId later — do not query Hero here.
 */
export function validateLobbyPlayers(players: LobbyPlayer[]): ValidatedLobby {
  const seenSlots = new Set<number>();

  for (const player of players) {
    if (player.slot < MIN_SLOT || player.slot > MAX_SLOT) {
      log.warn({ slot: player.slot }, 'Invalid lobby slot');
      throw new LobbyOcrError(
        `Invalid slot ${player.slot}. Slots must be between ${MIN_SLOT} and ${MAX_SLOT}.`,
      );
    }

    if (seenSlots.has(player.slot)) {
      log.warn({ slot: player.slot }, 'Duplicate lobby slot');
      throw new LobbyOcrError(`Duplicate slot ${player.slot} found in the screenshot reading.`);
    }

    seenSlots.add(player.slot);
  }

  const teamA = players
    .filter((player) => player.slot <= TEAM_A_MAX_SLOT)
    .sort((a, b) => a.slot - b.slot);

  const teamB = players
    .filter((player) => player.slot > TEAM_A_MAX_SLOT)
    .sort((a, b) => a.slot - b.slot);

  if (teamA.length === 0 || teamB.length === 0) {
    log.warn({ teamA: teamA.length, teamB: teamB.length }, 'Lobby missing a team');
    throw new LobbyOcrError(
      `Both ${teamDisplayName(1)} and ${teamDisplayName(2)} need at least one human player.`,
    );
  }

  log.debug({ teamA: teamA.length, teamB: teamB.length }, 'Lobby validation passed');
  return { teamA, teamB };
}
