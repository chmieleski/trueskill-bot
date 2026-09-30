#!/usr/bin/env node

/*
 * Decoder for the WOS2_BOT_V2 export written by Save2.j/SaveLoad.j.
 *
 * It accepts either:
 *   - the generated Warcraft III Preload .txt file;
 *   - the raw wire lines copied out of that file;
 *   - a previously decoded plaintext export (integrity checks are skipped).
 *
 * The map version is stored in the clear WOS2E header, so it is preserved in
 * the decoded output instead of being silently discarded.
 */

import fs from 'node:fs';

const MOD1 = 1000003;
const MOD2 = 1000033;
const RADIX = 87;
const K0 = 731921;
const K1 = 284117;
const K2 = 619403;
const K3 = 93761;
const K4 = 508217;
const K5 = 346891;
const PLAIN =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz _-.|=,:;!?/()[]{}+*@#%&'";
const CIPHER =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz _-.,:;!?/()[]{}+*@#%&'<>";
const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

if (PLAIN.length !== RADIX || CIPHER.length !== RADIX) {
  throw new Error('Codec alphabet length mismatch');
}

function posMod(value, base) {
  const result = value % base;
  return result < 0 ? result + base : result;
}

function plainIndex(ch) {
  return PLAIN.indexOf(ch);
}

function cipherIndex(ch) {
  return CIPHER.indexOf(ch);
}

function splitFields(line) {
  const parts = line.split('|');
  const type = parts.shift() || '';
  const fields = {};
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator < 0) {
      continue;
    }
    fields[part.slice(0, separator)] = part.slice(separator + 1);
  }
  return { type, fields };
}

function unescapeJassString(value) {
  return value.replace(/\\(\\|"|n|r|t)/g, (_match, escaped) => {
    if (escaped === 'n') return '\n';
    if (escaped === 'r') return '\r';
    if (escaped === 't') return '\t';
    return escaped;
  });
}

function extractWireLines(text) {
  const lines = [];
  const preloadPattern = /Preload\s*\(\s*"((?:\\.|[^"\\])*)"\s*\)/g;
  let match;
  while ((match = preloadPattern.exec(text)) !== null) {
    lines.push(unescapeJassString(match[1]));
  }
  if (lines.length > 0) {
    return lines;
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith('//') &&
        !line.startsWith('function ') &&
        line !== 'endfunction',
    )
    .filter((line) =>
      /^(?:WOS2E|D|Z|ID|MATCH|PLAYER|STATS|ITEMS|ITEM_RATE|END)\|/.test(line),
    );
}

function parseHeader(line) {
  const parsed = splitFields(line);
  if (parsed.type !== 'WOS2E') {
    throw new Error('Missing WOS2E header');
  }
  if (!parsed.fields.id || parsed.fields.alg !== 'R87M2') {
    throw new Error('Unsupported or incomplete WOS2E header');
  }
  return parsed.fields;
}

function createCodec(matchId) {
  const keyA = posMod(K0 + K2 * 3 - K4 + 17041, MOD1);
  const keyB = posMod(K1 + K3 * 5 + K5 + 29011, MOD2);
  const keyC = posMod(K4 + K0 * 2 - K1 + 39019, MOD1);
  const keyD = posMod(K5 + K2 * 2 - K3 + 49009, MOD2);

  let context = posMod(K0 + K3 + 19081, MOD1);
  for (const ch of matchId) {
    let symbol = plainIndex(ch) + 1;
    if (symbol <= 0) symbol = 1;
    context = posMod(context * 127 + symbol * 31 + K2, MOD1);
  }

  let chainA = posMod(keyC + context + 3301, MOD1);
  let chainB = posMod(keyD + context + 4409, MOD2);

  function computeMac(cipher, seq) {
    let macA = posMod(keyA + seq * 97 + 1103, MOD1);
    let macB = posMod(keyB + seq * 193 + 2203, MOD2);
    const feed = (symbol) => {
      macA = posMod(macA * 131 + symbol * 17 + (macB % 997) + keyC, MOD1);
      macB = posMod(macB * 137 + symbol * 29 + macA + keyD, MOD2);
    };
    for (const ch of matchId) {
      let symbol = plainIndex(ch) + 1;
      if (symbol <= 0) symbol = 1;
      feed(symbol);
    }
    feed(127);
    for (const ch of cipher) {
      const symbol = cipherIndex(ch) + 1;
      if (symbol <= 0) {
        throw new Error(`Cipher contains unsupported character: ${JSON.stringify(ch)}`);
      }
      feed(symbol);
    }
    return { macA, macB };
  }

  function updateChain(macA, macB, seq) {
    chainA = posMod(chainA * 149 + macA + seq * 31 + keyA, MOD1);
    chainB = posMod(chainB * 151 + macB + chainA + seq * 47 + keyB, MOD2);
  }

  function decrypt(cipher, seq) {
    let stream = posMod(context + keyB + seq * 389 + 71, MOD1);
    let result = '';
    let index = 0;
    for (const ch of cipher) {
      const cipherValue = cipherIndex(ch);
      if (cipherValue < 0) {
        throw new Error(`Cipher contains unsupported character: ${JSON.stringify(ch)}`);
      }
      stream = posMod(stream * 109 + 1021 + index * 17 + seq * 13, MOD1);
      const shift = posMod(stream + keyD, RADIX);
      result += PLAIN[posMod(cipherValue - shift, RADIX)];
      index += 1;
    }
    return result;
  }

  function finalTag(seq) {
    const finalA = posMod(chainA * 157 + seq * 53 + keyC, MOD1);
    const finalB = posMod(chainB * 163 + finalA + seq * 59 + keyD, MOD2);
    return `${finalA}|${finalB}`;
  }

  return { computeMac, decrypt, updateChain, finalTag };
}

function parseDecodedLine(line) {
  const parsed = splitFields(line);
  return { type: parsed.type, ...parsed.fields };
}

function base36Fixed4(value) {
  value = posMod(value, 1679616);
  let result = '';
  for (const divisor of [46656, 1296, 36, 1]) {
    const digit = Math.floor(value / divisor);
    result += BASE36[digit];
    value %= divisor;
  }
  return result;
}

function decode(text) {
  const wireLines = extractWireLines(text);
  if (wireLines.length === 0) {
    throw new Error('No WOS2 data lines found');
  }

  const headerLine = wireLines.find((line) => line.startsWith('WOS2E|'));
  const plaintextHeader = wireLines.find((line) => line.startsWith('HEADER|'));
  const encryptedLines = wireLines.filter((line) => line.startsWith('D|'));

  if (!headerLine || encryptedLines.length === 0) {
    const plainLines = wireLines.filter(
      (line) => !line.startsWith('WOS2E|') && !line.startsWith('HEADER|'),
    );
    const header = plaintextHeader
      ? parseDecodedLine(plaintextHeader)
      : {
          type: 'HEADER',
          map_version: 'unknown',
          integrity: 'not_available',
        };
    return {
      header,
      lines: plainLines,
      records: plainLines.map(parseDecodedLine),
      integrity: { verified: false, mode: 'plaintext_input' },
    };
  }

  const headerFields = parseHeader(headerLine);
  const codec = createCodec(headerFields.id);
  const decodedLines = [];
  let expectedSeq = 0;

  for (const line of encryptedLines) {
    const parsed = splitFields(line);
    if (
      parsed.type !== 'D' ||
      parsed.fields.s === undefined ||
      parsed.fields.c === undefined ||
      parsed.fields.t === undefined
    ) {
      throw new Error(`Malformed data line: ${line.slice(0, 80)}`);
    }
    const seq = Number(parsed.fields.s);
    if (!Number.isInteger(seq) || seq !== expectedSeq) {
      throw new Error(`Unexpected sequence: got ${parsed.fields.s}, expected ${expectedSeq}`);
    }
    const mac = codec.computeMac(parsed.fields.c, seq);
    const expectedTag = `${base36Fixed4(mac.macA)}${base36Fixed4(mac.macB)}`;
    if (expectedTag !== parsed.fields.t) {
      throw new Error(`MAC mismatch at sequence ${seq}`);
    }
    decodedLines.push(codec.decrypt(parsed.fields.c, seq));
    codec.updateChain(mac.macA, mac.macB, seq);
    expectedSeq += 1;
  }

  const endLine = wireLines.find((line) => line.startsWith('Z|'));
  if (!endLine) {
    throw new Error('Missing final Z line');
  }
  const end = splitFields(endLine);
  if (Number(end.fields.n) !== expectedSeq) {
    throw new Error(`Final sequence mismatch: got ${end.fields.n}, expected ${expectedSeq}`);
  }
  const [finalA, finalB] = codec.finalTag(expectedSeq).split('|').map(Number);
  const expectedFinalTag = `${base36Fixed4(finalA)}${base36Fixed4(finalB)}`;
  if (expectedFinalTag !== end.fields.t) {
    throw new Error('Final chain tag mismatch');
  }

  const decodedId = decodedLines.find((line) => line.startsWith('ID|'));
  if (!decodedId || splitFields(decodedId).fields.value !== headerFields.id) {
    throw new Error('Decoded ID does not match the WOS2E header');
  }
  const decodedEnd = decodedLines.find((line) => line.startsWith('END|'));
  if (!decodedEnd || splitFields(decodedEnd).fields.id !== headerFields.id) {
    throw new Error('Missing or mismatched decoded END record');
  }

  const header = {
    type: 'HEADER',
    version: headerFields.v || '',
    match_id: headerFields.id,
    algorithm: headerFields.alg,
    map_version: headerFields.map_version || 'unknown',
  };
  return {
    header,
    lines: decodedLines,
    records: decodedLines.map(parseDecodedLine),
    integrity: {
      verified: true,
      mode: 'WOS2_BOT_V2',
      data_lines: expectedSeq,
      final_line: true,
    },
  };
}

function usage() {
  return [
    'Usage: node examples/wos2/wos2_bot_decoder.js <input.txt> [-o output.txt] [--json]',
    '       node examples/wos2/wos2_bot_decoder.js <input.txt> --stdout',
    '',
    'Input may be a Preload export, raw WOS2 wire lines, or decoded plaintext.',
  ].join('\n');
}

function main(argv) {
  const args = [...argv];
  let input;
  let output;
  let json = false;
  let stdout = false;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--json') {
      json = true;
    } else if (arg === '--stdout') {
      stdout = true;
    } else if (arg === '-o' || arg === '--output') {
      output = args.shift();
      if (!output) throw new Error(`${arg} requires a path`);
    } else if (!input) {
      input = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (!input) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const result = decode(fs.readFileSync(input, 'utf8'));
  const rendered = json
    ? JSON.stringify(result, null, 2) + '\n'
    : [
        `HEADER|version=${result.header.version || ''}|match_id=${result.header.match_id || ''}|algorithm=${result.header.algorithm || ''}|map_version=${result.header.map_version || 'unknown'}`,
        ...result.lines,
        `INTEGRITY|verified=${result.integrity.verified ? 1 : 0}|mode=${result.integrity.mode}`,
      ].join('\n') + '\n';

  if (output && !stdout) {
    fs.writeFileSync(output, rendered, 'utf8');
  } else {
    process.stdout.write(rendered);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`Decode failed: ${error.message}`);
  process.exitCode = 1;
}
