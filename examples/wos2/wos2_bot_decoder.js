'use strict';

// Server-side WOS2E v1 decoder. Do not distribute this file to players.

const fs = require('node:fs');

const MOD1 = 1000003;
const MOD2 = 1000033;
const RADIX = 87;
const PLAIN = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz _-.|=,:;!?/()[]{}+*@#%&'";
const CIPHER = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz _-.,:;!?/()[]{}+*@#%&'<>";
const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// These key fragments must match WOS2BotCodec.j.
const K0 = 731921;
const K1 = 284117;
const K2 = 619403;
const K3 = 93761;
const K4 = 508217;
const K5 = 346891;

function posMod(value, base) {
  const result = value % base;
  return result < 0 ? result + base : result;
}

function deriveKeys() {
  return {
    a: posMod(K0 + K2 * 3 - K4 + 17041, MOD1),
    b: posMod(K1 + K3 * 5 + K5 + 29011, MOD2),
    c: posMod(K4 + K0 * 2 - K1 + 39019, MOD1),
    d: posMod(K5 + K2 * 2 - K3 + 49009, MOD2),
  };
}

function base36Fixed4(value) {
  let rest = posMod(value, 1679616);
  let divisor = 46656;
  let result = '';
  while (divisor > 0) {
    const digit = Math.floor(rest / divisor);
    result += BASE36[digit];
    rest %= divisor;
    divisor = Math.floor(divisor / 36);
  }
  return result;
}

function makeContext(matchId) {
  let context = posMod(K0 + K3 + 19081, MOD1);
  for (const ch of matchId) {
    let code = PLAIN.indexOf(ch) + 1;
    if (code <= 0) code = 1;
    context = posMod(context * 127 + code * 31 + K2, MOD1);
  }
  return context;
}

function computeMac(matchId, cipher, seq, keys) {
  let a = posMod(keys.a + seq * 97 + 1103, MOD1);
  let b = posMod(keys.b + seq * 193 + 2203, MOD2);

  function feed(code) {
    a = posMod(a * 131 + code * 17 + (b % 997) + keys.c, MOD1);
    b = posMod(b * 137 + code * 29 + a + keys.d, MOD2);
  }

  for (const ch of matchId) {
    let code = PLAIN.indexOf(ch) + 1;
    if (code <= 0) code = 1;
    feed(code);
  }
  feed(127);
  for (const ch of cipher) {
    const code = CIPHER.indexOf(ch) + 1;
    if (code <= 0) throw new Error('Ciphertext contains an invalid character');
    feed(code);
  }
  return { a, b, tag: base36Fixed4(a) + base36Fixed4(b) };
}

function updateChain(chain, mac, seq, keys) {
  const a = posMod(chain.a * 149 + mac.a + seq * 31 + keys.a, MOD1);
  const b = posMod(chain.b * 151 + mac.b + a + seq * 47 + keys.b, MOD2);
  return { a, b };
}

function decryptLine(cipher, seq, context, keys) {
  if (cipher.length === 0) {
    throw new Error(`Line ${seq}: invalid ciphertext length`);
  }
  let stream = posMod(context + keys.b + seq * 389 + 71, MOD1);
  let result = '';
  for (let pos = 0; pos < cipher.length; pos += 1) {
    const value = CIPHER.indexOf(cipher[pos]);
    if (value < 0) {
      throw new Error(`Line ${seq}: ciphertext contains an invalid character`);
    }
    stream = posMod(stream * 109 + 1021 + pos * 17 + seq * 13, MOD1);
    const shift = posMod(stream + keys.d, RADIX);
    const index = posMod(value - shift, RADIX);
    if (index >= PLAIN.length) {
      throw new Error(`Line ${seq}: incorrect key or corrupted data`);
    }
    result += PLAIN[index];
  }
  return result;
}

// Used only by the built-in compatibility self-test for the map-side algorithm.
function encodeForSelfTest(lines, matchId) {
  const keys = deriveKeys();
  const context = makeContext(matchId);
  let chain = {
    a: posMod(keys.c + context + 3301, MOD1),
    b: posMod(keys.d + context + 4409, MOD2),
  };
  const output = [`WOS2E|v=1|id=${matchId}|alg=R87M2`];

  lines.forEach((plain, seq) => {
    let stream = posMod(context + keys.b + seq * 389 + 71, MOD1);
    let cipher = '';
    [...plain].forEach((ch, pos) => {
      let index = PLAIN.indexOf(ch);
      if (index < 0) index = PLAIN.indexOf('_');
      stream = posMod(stream * 109 + 1021 + pos * 17 + seq * 13, MOD1);
      const shift = posMod(stream + keys.d, RADIX);
      const value = posMod(index + shift, RADIX);
      cipher += CIPHER[value];
    });
    const mac = computeMac(matchId, cipher, seq, keys);
    output.push(`D|s=${seq}|c=${cipher}|t=${mac.tag}`);
    chain = updateChain(chain, mac, seq, keys);
  });

  const finalA = posMod(chain.a * 157 + lines.length * 53 + keys.c, MOD1);
  const finalB = posMod(chain.b * 163 + finalA + lines.length * 59 + keys.d, MOD2);
  output.push(`Z|n=${lines.length}|t=${base36Fixed4(finalA)}${base36Fixed4(finalB)}`);
  return output.join('\n');
}

function constantTimeEqual(left, right) {
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (left.charCodeAt(i % Math.max(left.length, 1)) || 0)
      ^ (right.charCodeAt(i % Math.max(right.length, 1)) || 0);
  }
  return diff === 0;
}

function extractContainer(text) {
  const headerRegex = /WOS2E\|v=1\|id=([0-9A-Za-z_-]{1,80})\|alg=R87M2/g;
  const dataRegex = /D\|s=(\d+)\|c=([^|\r\n]+)\|t=([0-9A-Z]{8})/g;
  const endRegex = /Z\|n=(\d+)\|t=([0-9A-Z]{8})/g;
  const headers = [...text.matchAll(headerRegex)];
  const data = [...text.matchAll(dataRegex)];
  const ends = [...text.matchAll(endRegex)];

  if (headers.length !== 1) throw new Error('Expected exactly one WOS2E header');
  if (ends.length !== 1) throw new Error('Expected exactly one WOS2E final tag');
  if (data.length === 0) throw new Error('The container has no data records');
  if (headers[0].index > data[0].index || data[data.length - 1].index > ends[0].index) {
    throw new Error('Header, data records, and final tag are out of order');
  }

  return {
    matchId: headers[0][1],
    data: data.map((match) => ({
      seq: Number(match[1]),
      cipher: match[2],
      tag: match[3],
    })),
    endCount: Number(ends[0][1]),
    endTag: ends[0][2],
  };
}

function parseRecord(line) {
  const parts = line.split('|');
  const type = parts.shift();
  const fields = Object.create(null);
  for (const part of parts) {
    const split = part.indexOf('=');
    if (split <= 0) throw new Error(`Malformed field in ${type} record`);
    const key = part.slice(0, split);
    if (Object.hasOwn(fields, key)) throw new Error(`Duplicate ${key} field in ${type} record`);
    fields[key] = part.slice(split + 1);
  }
  return { type, fields, raw: line };
}

function readInt(record, key, min, max) {
  const value = record.fields[key];
  if (value === undefined || !/^-?\d+$/.test(value)) {
    throw new Error(`${record.type}.${key}: expected an integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${record.type}.${key}: value is out of range`);
  }
  return number;
}

function validateRecords(lines, matchId) {
  const records = lines.map(parseRecord);
  if (records.length < 3 || records[0].type !== 'ID' || records[1].type !== 'MATCH') {
    throw new Error('Expected ID and MATCH records');
  }
  if (records[0].fields.value !== matchId || records[0].fields.format !== 'WOS2_BOT_V2') {
    throw new Error('ID or format does not match the container');
  }
  if (records[0].fields.scope !== 'MATCH') throw new Error('Only scope=MATCH is supported');

  const match = records[1];
  const playerCount = readInt(match, 'players', 0, 10);
  readInt(match, 'team1_rounds', 0, 10000);
  readInt(match, 'team2_rounds', 0, 10000);
  if (readInt(match, 'schema', 2, 2) !== 2) throw new Error('Unsupported schema');
  readInt(match, 'teams_reorganized', 0, 1);

  const players = [];
  const seenPids = new Set();
  let cursor = 2;
  for (let index = 1; index <= playerCount; index += 1) {
    const player = records[cursor++];
    const stats = records[cursor++];
    const items = records[cursor++];
    if (!player || !stats || !items || player.type !== 'PLAYER' || stats.type !== 'STATS' || items.type !== 'ITEMS') {
      throw new Error(`Player ${index}: expected PLAYER, STATS, and ITEMS records`);
    }

    const n = readInt(player, 'n', index, index);
    const pid = readInt(player, 'pid', 0, 15);
    if (seenPids.has(pid)) throw new Error(`Duplicate pid=${pid}`);
    seenPids.add(pid);
    readInt(player, 'team', 0, 2);
    readInt(player, 'win', 0, 1);
    readInt(player, 'left', 0, 1);
    readInt(player, 'hero_id', -2147483648, 2147483647);
    readInt(player, 'lobby_slot', -1, 15);
    readInt(player, 'team_slot', -1, 15);
    readInt(player, 'visual_slot', -1, 15);

    if (readInt(stats, 'n', n, n) !== n || readInt(stats, 'pid', pid, pid) !== pid) {
      throw new Error(`Player ${index}: PLAYER and STATS records do not match`);
    }
    const statValues = Object.create(null);
    for (const key of ['rounds_played', 'round_wins', 'round_losses', 'kills', 'deaths',
      'damage_phys', 'damage_magic', 'damage_total', 'heal', 'taken_phys', 'taken_magic', 'taken_total']) {
      statValues[key] = readInt(stats, key, 0, 2147483647);
    }
    if (statValues.damage_total !== statValues.damage_phys + statValues.damage_magic
        || statValues.taken_total !== statValues.taken_phys + statValues.taken_magic) {
      throw new Error(`Player ${index}: invalid damage total`);
    }

    if (readInt(items, 'n', n, n) !== n || readInt(items, 'pid', pid, pid) !== pid) {
      throw new Error(`Player ${index}: PLAYER and ITEMS records do not match`);
    }
    for (let slot = 1; slot <= 6; slot += 1) {
      readInt(items, `slot${slot}`, -2147483648, 2147483647);
    }
    players.push({ player: player.fields, stats: stats.fields, items: items.fields });
  }

  const itemRates = [];
  while (cursor < records.length && records[cursor].type === 'ITEM_RATE') {
    const item = records[cursor++];
    readInt(item, 'item_id', -2147483648, 2147483647);
    const games = readInt(item, 'games', 1, 10);
    const wins = readInt(item, 'wins', 0, games);
    const winrate = readInt(item, 'winrate_pct', 0, 100);
    if (winrate !== Math.floor((wins * 100) / games)) throw new Error('ITEM_RATE: invalid winrate_pct');
    itemRates.push(item.fields);
  }

  const end = records[cursor++];
  if (!end || end.type !== 'END' || end.fields.id !== matchId || cursor !== records.length) {
    throw new Error('Missing a valid final END record');
  }
  return { match: match.fields, players, itemRates };
}

function decodeWos2BotExport(text) {
  if (typeof text !== 'string' || text.length > 1024 * 1024) {
    throw new Error('Invalid or oversized input file');
  }
  const container = extractContainer(text);
  const keys = deriveKeys();
  const context = makeContext(container.matchId);
  let chain = {
    a: posMod(keys.c + context + 3301, MOD1),
    b: posMod(keys.d + context + 4409, MOD2),
  };
  const lines = [];

  container.data.forEach((entry, index) => {
    if (entry.seq !== index) throw new Error(`Invalid sequence: expected line ${index}`);
    const mac = computeMac(container.matchId, entry.cipher, entry.seq, keys);
    if (!constantTimeEqual(mac.tag, entry.tag)) throw new Error(`Line ${index}: invalid authentication tag`);
    lines.push(decryptLine(entry.cipher, entry.seq, context, keys));
    chain = updateChain(chain, mac, entry.seq, keys);
  });

  if (container.endCount !== lines.length) throw new Error('The file is truncated or contains extra records');
  const finalA = posMod(chain.a * 157 + lines.length * 53 + keys.c, MOD1);
  const finalB = posMod(chain.b * 163 + finalA + lines.length * 59 + keys.d, MOD2);
  const finalTag = base36Fixed4(finalA) + base36Fixed4(finalB);
  if (!constantTimeEqual(finalTag, container.endTag)) throw new Error('Invalid final file authentication tag');

  const parsed = validateRecords(lines, container.matchId);
  return { matchId: container.matchId, ...parsed, lines };
}

module.exports = { decodeWos2BotExport };

if (require.main === module) {
  const fileName = process.argv[2];
  if (fileName === '--self-test') {
    const assert = require('node:assert/strict');
    const matchId = '12345678-23456789-34567890-45678901';
    const plainLines = [
      `ID|value=${matchId}|format=WOS2_BOT_V2|scope=MATCH`,
      'MATCH|team1_rounds=2|team2_rounds=1|players=1|schema=2|teams_reorganized=0',
      'PLAYER|n=1|pid=0|name=Test_Player|team=1|win=1|hero_id=1211117616|hero_name=Test Hero|left=0|lobby_slot=0|team_slot=0|visual_slot=0',
      'STATS|n=1|pid=0|rounds_played=3|round_wins=2|round_losses=1|kills=5|deaths=2|damage_phys=100|damage_magic=50|damage_total=150|heal=10|taken_phys=70|taken_magic=20|taken_total=90',
      'ITEMS|n=1|pid=0|slot1=1227894832|slot2=0|slot3=0|slot4=0|slot5=0|slot6=0',
      'ITEM_RATE|item_id=1227894832|item_name=Test Item|games=1|wins=1|winrate_pct=100',
      `END|id=${matchId}`,
    ];
    const encoded = encodeForSelfTest(plainLines, matchId);
    const decoded = decodeWos2BotExport(encoded);
    assert.equal(decoded.matchId, matchId);
    assert.deepEqual(decoded.lines, plainLines);
    const preloadFile = encoded.split('\n').map((line) => `call Preload( "${line}" )`).join('\n');
    assert.deepEqual(decodeWos2BotExport(preloadFile).lines, plainLines);

    const tampered = encoded.replace(/(\|c=)([0-9A-Z])/, (_, prefix, ch) => `${prefix}${ch === '0' ? '1' : '0'}`);
    assert.throws(() => decodeWos2BotExport(tampered), /invalid authentication tag/);
    const reordered = encoded.split('\n');
    [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
    assert.throws(() => decodeWos2BotExport(reordered.join('\n')), /Invalid sequence/);
    const truncated = encoded.split('\n');
    truncated.splice(2, 1);
    assert.throws(() => decodeWos2BotExport(truncated.join('\n')), /Invalid sequence|truncated/);
    console.log('WOS2 codec self-test: OK');
  } else if (!fileName) {
    console.error('Usage: node wos2_bot_decoder.js <export-file>');
    process.exitCode = 2;
  } else {
    try {
      const result = decodeWos2BotExport(fs.readFileSync(fileName, 'utf8'));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      console.error(`WOS2: file rejected: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
