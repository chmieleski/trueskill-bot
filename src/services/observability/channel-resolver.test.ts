import { test, expect, describe } from 'vitest';
import { resolveOpsAlertChannelIds } from './channel-resolver.js';

describe('resolveOpsAlertChannelIds', () => {
  test('env only', () => {
    expect(resolveOpsAlertChannelIds({ envChannelId: 'env-1', guildChannelIds: [] })).toEqual([
      'env-1',
    ]);
  });

  test('guild only', () => {
    expect(
      resolveOpsAlertChannelIds({ envChannelId: undefined, guildChannelIds: ['g1', 'g2'] }),
    ).toEqual(['g1', 'g2']);
  });

  test('both with dedupe', () => {
    expect(
      resolveOpsAlertChannelIds({
        envChannelId: 'same',
        guildChannelIds: ['same', ' other ', ''],
      }),
    ).toEqual(['same', 'other']);
  });
});
