import { describe, expect, it } from 'vitest';
import {
  buildReleasePrBody,
  commitSubjectToSummaryBullet,
  isReleaseSyncCommit,
  pickReleasePrTitle,
} from './release-pr-content.js';

describe('isReleaseSyncCommit', () => {
  it('matches semantic-release sync commits', () => {
    expect(isReleaseSyncCommit('chore(release): 1.9.0 [skip ci]')).toBe(true);
  });

  it('ignores feature commits', () => {
    expect(isReleaseSyncCommit('feat(match): show lobby win chance')).toBe(false);
  });
});

describe('pickReleasePrTitle', () => {
  it('uses the sole promotion commit subject', () => {
    expect(
      pickReleasePrTitle([{ subject: 'feat(match): show lobby win chance on report and show' }]),
    ).toBe('feat(match): show lobby win chance on report and show');
  });

  it('prefers feat over fix when multiple commits are queued', () => {
    expect(
      pickReleasePrTitle([
        { subject: 'fix(rating): soften lobby scale' },
        { subject: 'feat(match): show lobby win chance on report and show' },
      ]),
    ).toBe('feat(match): show lobby win chance on report and show');
  });

  it('ignores chore(release) sync commits', () => {
    expect(
      pickReleasePrTitle([
        { subject: 'chore(release): 1.9.0 [skip ci]' },
        { subject: 'fix(rating): soften lobby scale' },
      ]),
    ).toBe('fix(rating): soften lobby scale');
  });
});

describe('buildReleasePrBody', () => {
  it('builds summary and test plan sections', () => {
    const body = buildReleasePrBody([
      {
        subject: 'feat(match): show lobby win chance on report and show',
        summaryBullets: [
          '- Show Team A / Team B win % on completed match embeds (report + flip).',
        ],
        testPlanBullets: ['- [ ] Report a match and confirm win % matches the lobby preview'],
      },
    ]);

    expect(body).toContain('## Summary');
    expect(body).toContain(
      '- Show Team A / Team B win % on completed match embeds (report + flip).',
    );
    expect(body).toContain('## Test plan');
    expect(body).toContain('- [ ] Confirm CI passes on this PR');
    expect(body).toContain('- [ ] Report a match and confirm win % matches the lobby preview');
  });
});

describe('commitSubjectToSummaryBullet', () => {
  it('bolds the scope when present', () => {
    expect(commitSubjectToSummaryBullet('fix(rating): soften lobby scale')).toBe(
      '- **rating:** soften lobby scale',
    );
  });
});
