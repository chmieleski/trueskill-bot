import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const packScript = join(repoRoot, 'deploy/aws/pack-release.sh');

describe('pack-release.sh', () => {
  it('exists and is executable documentation for CI', () => {
    expect(existsSync(packScript)).toBe(true);
  });

  it('packs required release paths when dist already exists', () => {
    const distEntry = join(repoRoot, 'apps/bot/dist/index.js');
    if (!existsSync(distEntry)) {
      execFileSync(
        'bash',
        [
          '-lc',
          'export PATH="$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/bin:$PATH"; pnpm --filter @dbz/db generate && pnpm --filter @dbz/bot build',
        ],
        { cwd: repoRoot, stdio: 'inherit' },
      );
    }

    const out = mkdtempSync(join(tmpdir(), 'pack-release-'));
    const sha = 'deadbeefcafebabe';
    execFileSync('bash', [packScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        RELEASE_SHA: sha,
        PACK_OUT_DIR: out,
      },
      stdio: 'inherit',
    });

    const tar = join(out, `bot-${sha}.tar.gz`);
    expect(existsSync(tar)).toBe(true);

    const extract = mkdtempSync(join(tmpdir(), 'pack-extract-'));
    execFileSync('tar', ['-xzf', tar, '-C', extract]);
    const root = extract; // tarball entries are relative to release root

    expect(existsSync(join(root, 'apps/bot/dist/index.js'))).toBe(true);
    expect(existsSync(join(root, 'apps/bot/package.json'))).toBe(true);
    expect(existsSync(join(root, 'packages/db/prisma/schema.prisma'))).toBe(true);
    expect(existsSync(join(root, 'packages/db/prisma/migrations'))).toBe(true);
    expect(existsSync(join(root, 'packages/db/prisma.config.ts'))).toBe(true);
    expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(true);
    expect(existsSync(join(root, 'deploy/aws/host-update.sh'))).toBe(true);
    expect(existsSync(join(root, 'CHANGELOG.md'))).toBe(true);
    expect(existsSync(join(root, 'docs/discord/public'))).toBe(true);
    expect(existsSync(join(root, 'node_modules/.bin/prisma'))).toBe(true);
    expect(existsSync(join(root, 'node_modules/@dbz/db'))).toBe(true);
    expect(existsSync(join(root, 'packages/db/node_modules/@prisma/client'))).toBe(true);
    expect(existsSync(join(root, 'node_modules/@prisma/client'))).toBe(true);

    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { PrismaClient } from '@dbz/db'; if (typeof PrismaClient !== 'function') process.exit(2);",
      ],
      {
        cwd: root,
        env: { ...process.env, NODE_ENV: 'production' },
        stdio: 'inherit',
      },
    );

    execFileSync(join(root, 'node_modules/.bin/prisma'), ['-v'], {
      cwd: root,
      stdio: 'inherit',
    });

    const release = JSON.parse(readFileSync(join(root, 'RELEASE.json'), 'utf8')) as {
      sha: string;
      builtAt: string;
    };
    expect(release.sha).toBe(sha);
    expect(typeof release.builtAt).toBe('string');
    expect(release.builtAt.length).toBeGreaterThan(0);

    rmSync(out, { recursive: true, force: true });
    rmSync(extract, { recursive: true, force: true });
  }, 600_000);
});
