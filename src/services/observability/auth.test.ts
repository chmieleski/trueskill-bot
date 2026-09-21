import { test, expect, describe } from 'vitest';
import { authorizeObsRequest } from './auth.js';

describe('authorizeObsRequest', () => {
  test('loopback without token is ok', () => {
    expect(
      authorizeObsRequest({
        bind: '127.0.0.1',
        configuredToken: undefined,
        authorizationHeader: undefined,
      }),
    ).toEqual({ ok: true });
  });

  test('non-loopback without token is 401', () => {
    const result = authorizeObsRequest({
      bind: '0.0.0.0',
      configuredToken: undefined,
      authorizationHeader: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
    }
  });

  test('non-loopback with valid Bearer is ok', () => {
    expect(
      authorizeObsRequest({
        bind: '0.0.0.0',
        configuredToken: 'secret',
        authorizationHeader: 'Bearer secret',
      }),
    ).toEqual({ ok: true });
  });

  test('non-loopback with wrong Bearer is 401', () => {
    const result = authorizeObsRequest({
      bind: '0.0.0.0',
      configuredToken: 'secret',
      authorizationHeader: 'Bearer nope',
    });
    expect(result.ok).toBe(false);
  });
});
