#!/usr/bin/env node
/**
 * Print all in-game chat from a Warcraft III / Reforged .w3g replay.
 * Includes All, Team, Observers, and Private (with recipient when known).
 *
 * Chat-only parse: skips action decoding so custom maps (e.g. UDBR) still work.
 *
 * Usage:
 *   node print-chat.mjs <replay.w3g>
 *   node print-chat.mjs <replay.w3g> --mode all|team|private|observers
 *   node print-chat.mjs <replay.w3g> --json
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const parsersBase = new URL('./node_modules/w3gjs/dist/esm/parsers/', import.meta.url);
const { RawParser } = await import(new URL('RawParser.js', parsersBase).href);
const { MetadataParser } = await import(new URL('MetadataParser.js', parsersBase).href);
const { StatefulBufferParser } = await import(new URL('StatefulBufferParser.js', parsersBase).href);

/**
 * @param {number} ms
 * @returns {string}
 */
function formatTime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * WC3 chat mode dword:
 *   0x00 All, 0x01 Allies/Team, 0x02 Observers,
 *   0x03+N Private to slot N (slot index, not playerId).
 * @param {number} mode
 * @param {Map<number, string>} slotNames slotIndex → player name
 */
function describeMode(mode, slotNames) {
  if (mode === 0x00) return { kind: 'All', label: 'All' };
  if (mode === 0x01) return { kind: 'Team', label: 'Team' };
  if (mode === 0x02) return { kind: 'Observers', label: 'Observers' };
  if (mode >= 0x03) {
    const slotIndex = mode - 0x03;
    const targetName = slotNames.get(slotIndex) ?? `slot#${slotIndex}`;
    return {
      kind: 'Private',
      label: `Private→${targetName}`,
      targetSlot: slotIndex,
      targetName,
    };
  }
  return { kind: `Mode${mode}`, label: `Mode${mode}` };
}

/**
 * @param {Buffer} gameData
 * @param {Map<number, string>} players playerId → name
 * @param {Map<number, string>} slotNames slotIndex → name
 */
function extractChat(gameData, players, slotNames) {
  const parser = new StatefulBufferParser();
  parser.initialize(gameData);
  let ms = 0;
  /** @type {Array<Record<string, unknown>>} */
  const chats = [];

  while (parser.offset < gameData.length) {
    const id = parser.readUInt8();
    if (id === 0x17) {
      parser.skip(13);
      continue;
    }
    if (id === 0x1a || id === 0x1b || id === 0x1c) {
      parser.skip(4);
      continue;
    }
    if (id === 0x1e || id === 0x1f) {
      const byteCount = parser.readUInt16LE();
      const timeIncrement = parser.readUInt16LE();
      ms += timeIncrement;
      // Skip command/action payload — custom maps break action parsers.
      parser.skip(Math.max(0, byteCount - 2));
      continue;
    }
    if (id === 0x20) {
      const playerId = parser.readUInt8();
      parser.readUInt16LE(); // byteCount
      const flags = parser.readUInt8();
      let mode = 0;
      // 0x10 = lobby/startup string (no mode dword). 0x20 = normal chat.
      if (flags === 0x20) mode = parser.readUInt32LE();
      const message = parser.readZeroTermString('utf-8');
      const described = describeMode(mode, slotNames);
      chats.push({
        timeMS: ms,
        playerId,
        playerName: players.get(playerId) ?? `player#${playerId}`,
        mode,
        modeKind: flags === 0x10 ? 'Lobby' : described.kind,
        modeLabel: flags === 0x10 ? 'Lobby' : described.label,
        message,
        ...(described.targetSlot !== undefined
          ? { targetSlot: described.targetSlot, targetName: described.targetName }
          : {}),
      });
      continue;
    }
    if (id === 0x22) {
      const len = parser.readUInt8();
      parser.skip(len);
      continue;
    }
    if (id === 0x23) {
      parser.skip(10);
      continue;
    }
    if (id === 0x2f) {
      parser.skip(8);
      continue;
    }
    // Trailing padding / unknown — stop cleanly.
    break;
  }

  return chats;
}

function parseArgs(argv) {
  const args = { file: null, mode: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--mode') args.mode = String(argv[++i] ?? '').toLowerCase();
    else if (!a.startsWith('-') && !args.file) args.file = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    console.error(`Usage: node print-chat.mjs <replay.w3g> [--mode all|team|private|observers] [--json]

Modes in WC3 replays:
  All        — public chat (Enter)
  Team       — allies only (Shift+Enter)
  Observers  — observer channel
  Private    — whisper to one player (shows Private→name)`);
    process.exit(args.help ? 0 : 1);
  }

  const replayPath = resolve(args.file);
  const buf = readFileSync(replayPath);
  const raw = await new RawParser().parse(buf);
  const meta = await new MetadataParser().parse(raw.blocks);

  /** @type {Map<number, string>} */
  const players = new Map();
  for (const p of meta.playerRecords ?? []) players.set(p.playerId, p.playerName);
  for (const p of meta.reforgedPlayerMetadata ?? []) {
    if (p.name) players.set(p.playerId, p.name);
  }

  /** @type {Map<number, string>} */
  const slotNames = new Map();
  /** @type {string[]} */
  const observers = [];
  for (const [slotIndex, slot] of (meta.slotRecords ?? []).entries()) {
    if (slot.slotStatus < 2) continue;
    const name = players.get(slot.playerId) ?? `player#${slot.playerId}`;
    slotNames.set(slotIndex, name);
    // Custom games: observer/referee seats commonly use teamId >= 12, or
    // team slots past the two playing teams (here UDBR uses team 2).
    if (slot.teamId >= 12 || slot.teamId === 24) observers.push(name);
  }
  // Fallback for maps that park observers on a third "team" id (e.g. 2).
  if (observers.length === 0) {
    const teamIds = [
      ...new Set((meta.slotRecords ?? []).filter((s) => s.slotStatus > 1).map((s) => s.teamId)),
    ].sort((a, b) => a - b);
    if (teamIds.length >= 3) {
      const obsTeam = teamIds[teamIds.length - 1];
      for (const slot of meta.slotRecords ?? []) {
        if (slot.slotStatus > 1 && slot.teamId === obsTeam) {
          observers.push(players.get(slot.playerId) ?? `player#${slot.playerId}`);
        }
      }
    }
  }

  const allChats = extractChat(meta.gameData, players, slotNames);
  const counts = Object.create(null);
  for (const c of allChats) {
    counts[c.modeKind] = (counts[c.modeKind] ?? 0) + 1;
  }

  let chats = allChats;
  if (args.mode) {
    const want = args.mode.replace(/^obs.*/, 'observers');
    chats = allChats.filter((c) => c.modeKind.toLowerCase() === want);
  }

  const mapName = meta.map?.mapName ?? 'unknown map';
  const creator = meta.map?.creator ?? null;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          map: mapName,
          creator,
          players: Object.fromEntries(players),
          observers,
          counts,
          notes: [
            'WC3 only stores chat the replay-saver sent or received.',
            'Observer-channel messages (mode Observers) are typically not saved in .w3g.',
            'Private whispers between other players (not involving the saver) are absent.',
          ],
          chat: chats,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.error(`# ${mapName}`);
  if (creator) console.error(`# host/creator: ${creator}`);
  console.error(`# players: ${[...players.values()].join(', ')}`);
  if (observers.length) console.error(`# observers: ${observers.join(', ')}`);
  console.error(
    `# message counts: ${
      Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') || 'none'
    }`,
  );
  if (!(counts.Private > 0) || !(counts.Observers > 0)) {
    console.error(
      '# note: .w3g usually omits observer-channel chat, and only keeps private whispers involving the player who saved the replay. Missing Private/Observers here means they were not recorded in this file.',
    );
  }

  if (chats.length === 0) {
    console.error('(no chat messages' + (args.mode ? ` for mode ${args.mode}` : '') + ')');
    return;
  }

  for (const msg of chats) {
    console.log(`[${formatTime(msg.timeMS)}] [${msg.modeLabel}] ${msg.playerName}: ${msg.message}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
