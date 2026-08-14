import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearEphemeralSessionsForTests,
  ephemeralSessionKey,
  rememberEphemeral,
  takePreviousEphemeral,
  deletePreviousEphemeral,
} from './ephemeral-session.js';

describe('ephemeral-session', () => {
  beforeEach(() => {
    clearEphemeralSessionsForTests();
  });

  it('builds a stable user+channel key', () => {
    expect(ephemeralSessionKey('u1', 'c1')).toBe('u1:c1');
  });

  it('remember then takePrevious returns and clears', () => {
    rememberEphemeral('u1', 'c1', {
      applicationId: 'app',
      token: 'tok',
      messageId: 'm1',
    });

    expect(takePreviousEphemeral('u1', 'c1')).toEqual({
      applicationId: 'app',
      token: 'tok',
      messageId: 'm1',
    });
    expect(takePreviousEphemeral('u1', 'c1')).toBeNull();
  });

  it('isolates sessions by user and channel', () => {
    rememberEphemeral('u1', 'c1', {
      applicationId: 'app',
      token: 'a',
      messageId: '1',
    });
    rememberEphemeral('u2', 'c1', {
      applicationId: 'app',
      token: 'b',
      messageId: '2',
    });
    rememberEphemeral('u1', 'c2', {
      applicationId: 'app',
      token: 'c',
      messageId: '3',
    });

    expect(takePreviousEphemeral('u1', 'c1')?.messageId).toBe('1');
    expect(takePreviousEphemeral('u2', 'c1')?.messageId).toBe('2');
    expect(takePreviousEphemeral('u1', 'c2')?.messageId).toBe('3');
  });

  it('deletePreviousEphemeral no-ops when empty', async () => {
    await expect(
      deletePreviousEphemeral({} as never, 'u1', 'c1'),
    ).resolves.toBeUndefined();
  });
});
