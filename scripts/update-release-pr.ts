/**
 * Create or update the open release → main promotion PR.
 *
 * Reads commits on `release` that are not yet on `main`, builds a conventional
 * title/body, and opens or edits the matching pull request via the GitHub CLI.
 *
 * Usage:
 *   npx tsx scripts/update-release-pr.ts
 *   npx tsx scripts/update-release-pr.ts --dry-run
 */
import { execFileSync } from 'node:child_process';
import {
  buildReleasePrBody,
  isReleaseSyncCommit,
  pickReleasePrTitle,
  type ReleaseCommit,
} from '../src/services/release/release-pr-content.js';

const DRY_RUN = process.argv.includes('--dry-run');
const BASE = 'main';
const HEAD = 'release';

interface GitPromotionCommit {
  sha: string;
  subject: string;
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function runJson<T>(command: string, args: string[]): T {
  return JSON.parse(run(command, args)) as T;
}

function repoSlug(): string {
  return run('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
}

/** List promotion commits on release that are not on main. */
function listPromotionCommits(): GitPromotionCommit[] {
  const output = run('git', [
    'log',
    `origin/${BASE}..origin/${HEAD}`,
    '--format=%H%x1f%s',
    '--reverse',
  ]);
  if (!output) {
    return [];
  }

  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split('\x1f');
      return { sha: sha!, subject: subject! };
    })
    .filter((commit) => !isReleaseSyncCommit(commit.subject));
}

/** Pull Summary / Test plan bullets from a merged feature PR when available. */
function enrichCommitFromPullRequest(commit: GitPromotionCommit): ReleaseCommit {
  const enriched: ReleaseCommit = { subject: commit.subject };

  try {
    const pulls = runJson<Array<{ number: number }>>('gh', [
      'api',
      `repos/${repoSlug()}/commits/${commit.sha}/pulls`,
    ]);
    const pullNumber = pulls[0]?.number;
    if (!pullNumber) {
      return enriched;
    }

    const pr = runJson<{ body: string | null }>('gh', [
      'pr',
      'view',
      String(pullNumber),
      '--json',
      'body',
    ]);
    if (!pr.body) {
      return enriched;
    }

    enriched.summaryBullets = extractMarkdownBullets(pr.body, 'Summary');
    enriched.testPlanBullets = extractMarkdownBullets(pr.body, 'Test plan');
  } catch {
    // Best-effort enrichment; fall back to commit subject bullets.
  }

  return enriched;
}

/** Extract `- ...` lines under a `## Heading` section. */
function extractMarkdownBullets(markdown: string, heading: string): string[] | undefined {
  const pattern = new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?:\\n## |$)`, 'i');
  const match = pattern.exec(markdown);
  if (!match?.[1]) {
    return undefined;
  }

  const bullets = match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));
  return bullets.length > 0 ? bullets : undefined;
}

function findOpenReleasePr(): number | null {
  const pulls = runJson<Array<{ number: number }>>('gh', [
    'pr',
    'list',
    '--base',
    BASE,
    '--head',
    HEAD,
    '--state',
    'open',
    '--json',
    'number',
  ]);
  return pulls[0]?.number ?? null;
}

function main(): void {
  run('git', ['fetch', 'origin', BASE, HEAD]);

  const aheadCount = Number(
    run('git', ['rev-list', '--count', `origin/${BASE}..origin/${HEAD}`]) || '0',
  );

  if (aheadCount === 0) {
    console.log(`release is not ahead of ${BASE}; nothing to promote.`);
    return;
  }

  const gitCommits = listPromotionCommits();
  const commits = gitCommits.map(enrichCommitFromPullRequest);
  const title = pickReleasePrTitle(commits);
  const body = buildReleasePrBody(commits);

  const existing = findOpenReleasePr();
  if (DRY_RUN) {
    console.log(
      JSON.stringify(
        {
          action: existing ? 'update' : 'create',
          number: existing,
          title,
          body,
          aheadCount,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (existing) {
    run('gh', ['pr', 'edit', String(existing), '--title', title, '--body', body]);
    console.log(`Updated release PR #${existing}: ${title}`);
    return;
  }

  run('gh', ['pr', 'create', '--base', BASE, '--head', HEAD, '--title', title, '--body', body]);
  console.log(`Created release PR: ${title}`);
}

main();
