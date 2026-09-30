/**
 * Server-side WOS2E (alg=R87M2) codec for WOS2_BOT_V2 map exports.
 * Key fragments must match the map's WOS2BotCodec.j — do not distribute to players.
 */

const MOD1 = 1000003;
const MOD2 = 1000033;
const RADIX = 87;
const PLAIN =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz _-.|=,:;!?/()[]{}+*@#%&'";
const CIPHER =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz _-.,:;!?/()[]{}+*@#%&'<>";
const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const K0 = 731921;
const K1 = 284117;
const K2 = 619403;
const K3 = 93761;
const K4 = 508217;
const K5 = 346891;

const MAX_INPUT_BYTES = 1024 * 1024;

export class Wos2eCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Wos2eCodecError';
  }
}

type CodecKeys = { a: number; b: number; c: number; d: number };
type MacState = { a: number; b: number; tag: string };
type ChainState = { a: number; b: number };

function posMod(value: number, base: number): number {
  const result = value % base;
  return result < 0 ? result + base : result;
}

function deriveKeys(): CodecKeys {
  return {
    a: posMod(K0 + K2 * 3 - K4 + 17041, MOD1),
    b: posMod(K1 + K3 * 5 + K5 + 29011, MOD2),
    c: posMod(K4 + K0 * 2 - K1 + 39019, MOD1),
    d: posMod(K5 + K2 * 2 - K3 + 49009, MOD2),
  };
}

function base36Fixed4(value: number): string {
  let rest = posMod(value, 1679616);
  let result = '';
  for (const divisor of [46656, 1296, 36, 1]) {
    const digit = Math.floor(rest / divisor);
    result += BASE36[digit]!;
    rest %= divisor;
  }
  return result;
}

function makeContext(matchId: string): number {
  let context = posMod(K0 + K3 + 19081, MOD1);
  for (const ch of matchId) {
    let code = PLAIN.indexOf(ch) + 1;
    if (code <= 0) {
      code = 1;
    }
    context = posMod(context * 127 + code * 31 + K2, MOD1);
  }
  return context;
}

function computeMac(matchId: string, cipher: string, seq: number, keys: CodecKeys): MacState {
  let a = posMod(keys.a + seq * 97 + 1103, MOD1);
  let b = posMod(keys.b + seq * 193 + 2203, MOD2);

  function feed(code: number): void {
    a = posMod(a * 131 + code * 17 + (b % 997) + keys.c, MOD1);
    b = posMod(b * 137 + code * 29 + a + keys.d, MOD2);
  }

  for (const ch of matchId) {
    let code = PLAIN.indexOf(ch) + 1;
    if (code <= 0) {
      code = 1;
    }
    feed(code);
  }
  feed(127);
  for (const ch of cipher) {
    const code = CIPHER.indexOf(ch) + 1;
    if (code <= 0) {
      throw new Wos2eCodecError('Ciphertext contains an invalid character');
    }
    feed(code);
  }
  return { a, b, tag: base36Fixed4(a) + base36Fixed4(b) };
}

function updateChain(chain: ChainState, mac: MacState, seq: number, keys: CodecKeys): ChainState {
  const a = posMod(chain.a * 149 + mac.a + seq * 31 + keys.a, MOD1);
  const b = posMod(chain.b * 151 + mac.b + a + seq * 47 + keys.b, MOD2);
  return { a, b };
}

function decryptLine(cipher: string, seq: number, context: number, keys: CodecKeys): string {
  if (cipher.length === 0) {
    throw new Wos2eCodecError(`Line ${seq}: invalid ciphertext length`);
  }
  let stream = posMod(context + keys.b + seq * 389 + 71, MOD1);
  let result = '';
  for (let pos = 0; pos < cipher.length; pos += 1) {
    const value = CIPHER.indexOf(cipher[pos]!);
    if (value < 0) {
      throw new Wos2eCodecError(`Line ${seq}: ciphertext contains an invalid character`);
    }
    stream = posMod(stream * 109 + 1021 + pos * 17 + seq * 13, MOD1);
    const shift = posMod(stream + keys.d, RADIX);
    const index = posMod(value - shift, RADIX);
    if (index >= PLAIN.length) {
      throw new Wos2eCodecError(`Line ${seq}: incorrect key or corrupted data`);
    }
    result += PLAIN[index]!;
  }
  return result;
}

function constantTimeEqual(left: string, right: string): boolean {
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    diff |=
      (left.charCodeAt(i % Math.max(left.length, 1)) || 0) ^
      (right.charCodeAt(i % Math.max(right.length, 1)) || 0);
  }
  return diff === 0;
}

type ContainerData = { seq: number; cipher: string; tag: string };

type ExtractedContainer = {
  matchId: string;
  version: string;
  mapVersion: string | undefined;
  data: ContainerData[];
  endCount: number;
  endTag: string;
};

type SplitFields = { type: string; fields: Record<string, string> };

/** Split a pipe-record line into type + key=value fields. */
function splitFields(line: string): SplitFields {
  const parts = line.split('|');
  const type = parts.shift() || '';
  const fields: Record<string, string> = {};
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator < 0) {
      continue;
    }
    fields[part.slice(0, separator)] = part.slice(separator + 1);
  }
  return { type, fields };
}

/** Unescape JASS string literals inside Preload("…") arguments. */
function unescapeJassString(value: string): string {
  return value.replace(/\\(\\|"|n|r|t)/g, (_match, escaped: string) => {
    if (escaped === 'n') return '\n';
    if (escaped === 'r') return '\r';
    if (escaped === 't') return '\t';
    return escaped;
  });
}

/**
 * Extract WOS2 wire lines from a Preload export, raw wire text, or mixed input.
 * Prefers Preload("…") payloads when present.
 */
function extractWireLines(text: string): string[] {
  const lines: string[] = [];
  const preloadPattern = /Preload\s*\(\s*"((?:\\.|[^"\\])*)"\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = preloadPattern.exec(text)) !== null) {
    lines.push(unescapeJassString(match[1]!));
  }
  if (lines.length > 0) {
    return lines;
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line && !line.startsWith('//') && !line.startsWith('function ') && line !== 'endfunction',
    )
    .filter((line) => /^(?:WOS2E|D|Z|ID|MATCH|PLAYER|STATS|ITEMS|ITEM_RATE|END)\|/.test(line));
}

function extractContainer(text: string): ExtractedContainer {
  const wireLines = extractWireLines(text);
  if (wireLines.length === 0) {
    throw new Wos2eCodecError('No WOS2 data lines found');
  }

  const headerLine = wireLines.find((line) => line.startsWith('WOS2E|'));
  const encryptedLines = wireLines.filter((line) => line.startsWith('D|'));
  const endLine = wireLines.find((line) => line.startsWith('Z|'));

  if (!headerLine) {
    throw new Wos2eCodecError('Expected exactly one WOS2E header');
  }
  if (!endLine) {
    throw new Wos2eCodecError('Expected exactly one WOS2E final tag');
  }
  if (encryptedLines.length === 0) {
    throw new Wos2eCodecError('The container has no data records');
  }

  const header = splitFields(headerLine);
  if (header.type !== 'WOS2E' || !header.fields.id || header.fields.alg !== 'R87M2') {
    throw new Wos2eCodecError('Unsupported or incomplete WOS2E header');
  }
  if (!/^[0-9A-Za-z_-]{1,80}$/.test(header.fields.id)) {
    throw new Wos2eCodecError('Unsupported or incomplete WOS2E header');
  }

  const headerIndex = wireLines.indexOf(headerLine);
  const endIndex = wireLines.indexOf(endLine);
  const firstDataIndex = wireLines.indexOf(encryptedLines[0]!);
  const lastDataIndex = wireLines.indexOf(encryptedLines[encryptedLines.length - 1]!);
  if (headerIndex > firstDataIndex || lastDataIndex > endIndex) {
    throw new Wos2eCodecError('Header, data records, and final tag are out of order');
  }

  const end = splitFields(endLine);
  if (end.fields.n === undefined || end.fields.t === undefined) {
    throw new Wos2eCodecError('Expected exactly one WOS2E final tag');
  }
  if (!/^[0-9A-Z]{8}$/.test(end.fields.t)) {
    throw new Wos2eCodecError('Expected exactly one WOS2E final tag');
  }

  const data: ContainerData[] = encryptedLines.map((line) => {
    const parsed = splitFields(line);
    if (
      parsed.type !== 'D' ||
      parsed.fields.s === undefined ||
      parsed.fields.c === undefined ||
      parsed.fields.t === undefined
    ) {
      throw new Wos2eCodecError(`Malformed data line: ${line.slice(0, 80)}`);
    }
    if (!/^[0-9A-Z]{8}$/.test(parsed.fields.t)) {
      throw new Wos2eCodecError(`Malformed data line: ${line.slice(0, 80)}`);
    }
    return {
      seq: Number(parsed.fields.s),
      cipher: parsed.fields.c,
      tag: parsed.fields.t,
    };
  });

  return {
    matchId: header.fields.id,
    version: header.fields.v || '',
    mapVersion: header.fields.map_version,
    data,
    endCount: Number(end.fields.n),
    endTag: end.fields.t,
  };
}

export type Wos2eDecodeResult = {
  matchId: string;
  lines: string[];
  /** Cleartext protocol version from the WOS2E header (`v=`), when present. */
  version?: string;
  /** Cleartext map version from the WOS2E header (`map_version=`), when present. */
  mapVersion?: string;
};

export type EncodeWos2eOptions = {
  /** Optional cleartext map version written into the WOS2E header. */
  mapVersion?: string;
  /** Optional cleartext protocol version (default `1`). */
  version?: string;
};

/** Encrypt plaintext pipe-record lines into a WOS2E container (for tests / fixtures). */
export function encodeWos2eExport(
  lines: string[],
  matchId: string,
  options: EncodeWos2eOptions = {},
): string {
  const keys = deriveKeys();
  const context = makeContext(matchId);
  let chain: ChainState = {
    a: posMod(keys.c + context + 3301, MOD1),
    b: posMod(keys.d + context + 4409, MOD2),
  };
  const version = options.version ?? '1';
  const headerFields = [`v=${version}`, `id=${matchId}`, 'alg=R87M2'];
  if (options.mapVersion !== undefined && options.mapVersion !== '') {
    headerFields.push(`map_version=${options.mapVersion}`);
  }
  const output = [`WOS2E|${headerFields.join('|')}`];

  lines.forEach((plain, seq) => {
    let stream = posMod(context + keys.b + seq * 389 + 71, MOD1);
    let cipher = '';
    [...plain].forEach((ch, pos) => {
      let index = PLAIN.indexOf(ch);
      if (index < 0) {
        index = PLAIN.indexOf('_');
      }
      stream = posMod(stream * 109 + 1021 + pos * 17 + seq * 13, MOD1);
      const shift = posMod(stream + keys.d, RADIX);
      const value = posMod(index + shift, RADIX);
      cipher += CIPHER[value]!;
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

/** Decrypt and authenticate a WOS2E export; returns plaintext pipe-record lines. */
export function decodeWos2eExport(text: string): Wos2eDecodeResult {
  if (typeof text !== 'string' || text.length > MAX_INPUT_BYTES) {
    throw new Wos2eCodecError('Invalid or oversized input file');
  }
  const container = extractContainer(text);
  const keys = deriveKeys();
  const context = makeContext(container.matchId);
  let chain: ChainState = {
    a: posMod(keys.c + context + 3301, MOD1),
    b: posMod(keys.d + context + 4409, MOD2),
  };
  const lines: string[] = [];

  container.data.forEach((entry, index) => {
    if (entry.seq !== index) {
      throw new Wos2eCodecError(`Invalid sequence: expected line ${index}`);
    }
    const mac = computeMac(container.matchId, entry.cipher, entry.seq, keys);
    if (!constantTimeEqual(mac.tag, entry.tag)) {
      throw new Wos2eCodecError(`Line ${index}: invalid authentication tag`);
    }
    lines.push(decryptLine(entry.cipher, entry.seq, context, keys));
    chain = updateChain(chain, mac, entry.seq, keys);
  });

  if (container.endCount !== lines.length) {
    throw new Wos2eCodecError('The file is truncated or contains extra records');
  }
  const finalA = posMod(chain.a * 157 + lines.length * 53 + keys.c, MOD1);
  const finalB = posMod(chain.b * 163 + finalA + lines.length * 59 + keys.d, MOD2);
  const finalTag = base36Fixed4(finalA) + base36Fixed4(finalB);
  if (!constantTimeEqual(finalTag, container.endTag)) {
    throw new Wos2eCodecError('Invalid final file authentication tag');
  }

  const decodedId = lines.find((line) => line.startsWith('ID|'));
  if (!decodedId || splitFields(decodedId).fields.value !== container.matchId) {
    throw new Wos2eCodecError('Decoded ID does not match the WOS2E header');
  }
  const decodedEnd = lines.find((line) => line.startsWith('END|'));
  if (!decodedEnd || splitFields(decodedEnd).fields.id !== container.matchId) {
    throw new Wos2eCodecError('Missing or mismatched decoded END record');
  }

  return {
    matchId: container.matchId,
    lines,
    version: container.version || undefined,
    mapVersion: container.mapVersion,
  };
}
