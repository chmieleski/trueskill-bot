/** Conventional-commit type priority when picking a release PR title from multiple commits. */
const COMMIT_TYPE_PRIORITY: Record<string, number> = {
  feat: 4,
  fix: 3,
  perf: 2,
  refactor: 1,
};

export interface ReleaseCommit {
  /** First line of the commit message (subject). */
  subject: string;
  /** Optional markdown summary bullets pulled from a merged feature PR. */
  summaryBullets?: string[];
  /** Optional markdown test-plan bullets pulled from a merged feature PR. */
  testPlanBullets?: string[];
}

const RELEASE_COMMIT_PREFIX = /^chore\(release\):/i;

/** True when the commit is an automated semantic-release sync commit. */
export function isReleaseSyncCommit(subject: string): boolean {
  return RELEASE_COMMIT_PREFIX.test(subject.trim());
}

/** Parse `type(scope): description` from a conventional commit subject. */
export function parseConventionalSubject(subject: string): {
  type: string;
  scope?: string;
  description: string;
} {
  const match = /^(\w+)(?:\(([^)]+)\))?: (.+)$/.exec(subject.trim());
  if (!match) {
    return { type: 'chore', description: subject.trim() };
  }
  return {
    type: match[1]!.toLowerCase(),
    scope: match[2],
    description: match[3]!.trim(),
  };
}

/**
 * Pick the release PR title from promotion commits.
 * Uses the highest-priority conventional type; ties keep document order.
 */
export function pickReleasePrTitle(commits: ReleaseCommit[]): string {
  const promotionCommits = commits.filter((commit) => !isReleaseSyncCommit(commit.subject));
  if (promotionCommits.length === 0) {
    return 'chore: promote release to main';
  }
  if (promotionCommits.length === 1) {
    return promotionCommits[0]!.subject;
  }

  let best = promotionCommits[0]!;
  let bestPriority = COMMIT_TYPE_PRIORITY[parseConventionalSubject(best.subject).type] ?? 0;

  for (const commit of promotionCommits.slice(1)) {
    const priority = COMMIT_TYPE_PRIORITY[parseConventionalSubject(commit.subject).type] ?? 0;
    if (priority > bestPriority) {
      best = commit;
      bestPriority = priority;
    }
  }

  return best.subject;
}

/** Turn a conventional commit subject into a release-summary bullet. */
export function commitSubjectToSummaryBullet(subject: string): string {
  const parsed = parseConventionalSubject(subject);
  if (parsed.scope) {
    return `- **${parsed.scope}:** ${parsed.description}`;
  }
  return `- ${parsed.description}`;
}

/**
 * Build the markdown body for a release → main promotion PR.
 */
export function buildReleasePrBody(commits: ReleaseCommit[]): string {
  const promotionCommits = commits.filter((commit) => !isReleaseSyncCommit(commit.subject));

  const summaryLines: string[] = [];
  for (const commit of promotionCommits) {
    if (commit.summaryBullets?.length) {
      summaryLines.push(...commit.summaryBullets);
      continue;
    }
    summaryLines.push(commitSubjectToSummaryBullet(commit.subject));
  }

  const testPlanLines = new Set<string>([
    '- [ ] Confirm CI passes on this PR',
    '- [ ] After squash-merge to `main`, verify semantic-release cuts the expected version and deploy runs',
  ]);
  for (const commit of promotionCommits) {
    for (const bullet of commit.testPlanBullets ?? []) {
      testPlanLines.add(bullet);
    }
  }

  if (summaryLines.length === 0) {
    summaryLines.push('- Sync `release` to `main` (no feature commits pending).');
  }

  return ['## Summary', ...summaryLines, '', '## Test plan', ...testPlanLines].join('\n');
}
