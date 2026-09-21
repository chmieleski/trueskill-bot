import { test, expect, describe } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authorizeObsRequest } from './auth.js';
import { handleObsRequest } from './http-server.js';
import { metricsRegistry } from './registry.js';

function mockRes(): {
  res: ServerResponse;
  getStatus(): number;
  getBody(): string;
} {
  let statusCode = 0;
  let body = '';
  let headersSent = false;

  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(v: number) {
      statusCode = v;
    },
    get headersSent() {
      return headersSent;
    },
    setHeader() {
      return this;
    },
    end(payload?: string | Buffer) {
      body = payload == null ? '' : String(payload);
      headersSent = true;
    },
  } as unknown as ServerResponse;

  return {
    res,
    getStatus: () => statusCode,
    getBody: () => body,
  };
}

describe('handleObsRequest', () => {
  test('returns health ok when discord ready and db ok', async () => {
    metricsRegistry.setDiscord({ ready: true, pingMs: 10, guildCount: 1 });
    metricsRegistry.setSample(
      { rssMb: 100, heapUsedMb: 50, eventLoopP99Ms: 5 },
      { ok: true, latencyMs: 2 },
    );

    const mock = mockRes();
    const handled = await handleObsRequest(
      { method: 'GET', url: '/health', headers: {} } as IncomingMessage,
      mock.res,
    );
    expect(handled).toBe(true);
    expect(mock.getStatus()).toBe(200);
    expect(JSON.parse(mock.getBody())).toEqual({ ok: true });
  });

  test('status returns snapshot shape', async () => {
    metricsRegistry.setVersion('9.9.9');
    metricsRegistry.setDiscord({ ready: true, pingMs: 12, guildCount: 2 });
    metricsRegistry.setSample(
      { rssMb: 120, heapUsedMb: 60, eventLoopP99Ms: 8 },
      { ok: true, latencyMs: 3 },
    );

    const mock = mockRes();
    await handleObsRequest(
      { method: 'GET', url: '/status', headers: {} } as IncomingMessage,
      mock.res,
    );
    const body = JSON.parse(mock.getBody()) as Record<string, unknown>;
    expect(mock.getStatus()).toBe(200);
    expect(body.version).toBe('9.9.9');
    expect(body).toHaveProperty('uptimeSec');
    expect(body).toHaveProperty('discord');
    expect(body).toHaveProperty('process');
    expect(body).toHaveProperty('db');
    expect(body).toHaveProperty('counters');
  });

  test('authorize helper still rejects non-loopback without matching token', () => {
    const result = authorizeObsRequest({
      bind: '0.0.0.0',
      configuredToken: 'x',
      authorizationHeader: undefined,
    });
    expect(result.ok).toBe(false);
  });
});
