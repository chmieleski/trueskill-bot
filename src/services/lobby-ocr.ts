import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env.js';

export interface LobbyPlayer {
  slot: number;
  nick: string;
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
  "Você é um extrator de dados OCR focado na tela de lobby do jogo Warcraft III. A tela apresenta uma lista vertical que sempre contém exatamente 12 posições (slots), lidas de cima para baixo. Regras: 1. Slots de 1 a 6 são da Equipe A. Slots de 7 a 12 são da Equipe B. 2. Ignore slots escritos 'Open', 'Closed' ou 'Computer'. 3. Extraia apenas nicks de jogadores humanos, associando-os ao número do slot absoluto (linha da tela de 1 a 12). Retorne APENAS JSON no formato: { \"players\": [ { \"slot\": 1, \"nick\": \"Nome\" } ] }";

const MIN_SLOT = 1;
const MAX_SLOT = 12;
const TEAM_A_MAX_SLOT = 6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePlayersPayload(raw: string): LobbyPlayer[] {
  let parsed: unknown;

  console.log('raw', raw);

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LobbyOcrError('Could not parse the lobby screenshot. Please try again with a clearer image.');
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.players)) {
    throw new LobbyOcrError('Could not parse the lobby screenshot. Please try again with a clearer image.');
  }

  const players: LobbyPlayer[] = [];

  for (const entry of parsed.players) {
    if (!isRecord(entry)) {
      throw new LobbyOcrError('Could not parse the lobby screenshot. Please try again with a clearer image.');
    }

    const slot = typeof entry.slot === 'number' ? entry.slot : Number(entry.slot);
    const nick = typeof entry.nick === 'string' ? entry.nick : '';

    if (!Number.isInteger(slot) || nick.trim() === '') {
      throw new LobbyOcrError('Could not parse the lobby screenshot. Please try again with a clearer image.');
    }

    players.push({
      slot,
      nick: nick.trim().toLowerCase(),
    });
  }

  return players;
}

/**
 * Fetch a Discord attachment image and extract human lobby players via Gemini vision OCR.
 */
export async function extractLobbyPlayers(
  imageUrl: string,
  mimeType: string,
): Promise<LobbyPlayer[]> {
  const imageResponse = await fetch(imageUrl);

  if (!imageResponse.ok) {
    throw new LobbyOcrError('Could not download the lobby screenshot. Please try again.');
  }

  const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
  const base64Image = imageBuffer.toString('base64');

  const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });

  let response;

  try {
    response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
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
    console.error('Gemini lobby OCR request failed:', error);
    throw new LobbyOcrError('Lobby OCR failed. Please try again in a moment.');
  }

  const text = response.text;

  if (!text) {
    throw new LobbyOcrError('Could not read the lobby screenshot. Please try again with a clearer image.');
  }

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
      throw new LobbyOcrError(
        `Invalid slot ${player.slot}. Slots must be between ${MIN_SLOT} and ${MAX_SLOT}.`,
      );
    }

    if (seenSlots.has(player.slot)) {
      throw new LobbyOcrError(`Duplicate slot ${player.slot} found in the screenshot reading.`);
    }

    seenSlots.add(player.slot);
  }

  console.log('players', players);

  const teamA = players
    .filter((player) => player.slot <= TEAM_A_MAX_SLOT)
    .sort((a, b) => a.slot - b.slot);

  const teamB = players
    .filter((player) => player.slot > TEAM_A_MAX_SLOT)
    .sort((a, b) => a.slot - b.slot);

  if (teamA.length === 0 || teamB.length === 0) {
    throw new LobbyOcrError('Both Team A and Team B need at least one human player.');
  }

  return { teamA, teamB };
}
