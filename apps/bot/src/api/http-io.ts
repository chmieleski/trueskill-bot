import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

/** Write a JSON response with the given status code. */
export function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(payload);
}

/**
 * Read and parse a JSON request body with a hard size limit.
 * Throws Error with an English message on oversized or invalid JSON.
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('Request body is too large.');
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') {
    throw new Error('Request body must be JSON.');
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Request body must be valid JSON.');
  }
}
