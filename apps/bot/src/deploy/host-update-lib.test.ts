import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const lib = join(repoRoot, 'deploy/aws/host-update-lib.sh');

function bash(script: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('bash', ['-lc', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      status: typeof err.status === 'number' ? err.status : 1,
    };
  }
}

describe('host-update-lib', () => {
  it('names stage and prev as sibling suffixes', () => {
    const result = bash(
      `source '${lib}'; host_update_stage_dir /home/ubuntu/bot; host_update_prev_dir /home/ubuntu/bot`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      '/home/ubuntu/bot.next',
      '/home/ubuntu/bot.prev',
    ]);
  });

  it('deletes leftover prev when the unit is active', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-update-'));
    const app = join(root, 'bot');
    const prev = `${app}.prev`;
    mkdirSync(prev);
    const result = bash(`source '${lib}'; host_update_handle_leftover_prev '${app}' yes`);
    expect(result.status).toBe(0);
    expect(existsSync(prev)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it('restores leftover prev when the unit is inactive', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-update-'));
    const app = join(root, 'bot');
    const prev = `${app}.prev`;
    mkdirSync(app);
    mkdirSync(prev);
    writeFileSync(join(app, 'live.txt'), 'broken');
    writeFileSync(join(prev, 'good.txt'), 'good');

    const result = bash(
      `source '${lib}'; systemctl() { case "$1" in start) return 0;; is-active) return 0;; *) return 0;; esac; }; export -f systemctl; host_update_handle_leftover_prev '${app}' no`,
    );
    expect(result.status).toBe(0);
    expect(existsSync(prev)).toBe(false);
    expect(existsSync(app)).toBe(true);
    expect(existsSync(`${app}.failed`)).toBe(true);
    expect(readFileSync(join(app, 'good.txt'), 'utf8')).toBe('good');
    rmSync(root, { recursive: true, force: true });
  });

  it('continues deploy when prev restore cannot start dbz-bot', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-update-'));
    const app = join(root, 'bot');
    const prev = `${app}.prev`;
    mkdirSync(app);
    mkdirSync(prev);
    writeFileSync(join(prev, 'good.txt'), 'good');

    const result = bash(
      `source '${lib}'; systemctl() { case "$1" in start) return 1;; is-active) return 1;; *) return 0;; esac; }; export -f systemctl; host_update_handle_leftover_prev '${app}' no`,
    );
    expect(result.status).toBe(0);
    expect(existsSync(prev)).toBe(false);
    expect(existsSync(app)).toBe(true);
    expect(readFileSync(join(app, 'good.txt'), 'utf8')).toBe('good');
    rmSync(root, { recursive: true, force: true });
  });

  it('is a no-op when prev is absent', () => {
    const result = bash(`source '${lib}'; host_update_handle_leftover_prev '/no/such/bot' no`);
    expect(result.status).toBe(0);
  });

  it('detects local filesystem git remotes', () => {
    const result = bash(
      `source '${lib}';
       host_update_is_local_git_remote /home/ubuntu/bot && echo local || echo remote;
       host_update_is_local_git_remote https://github.com/org/repo.git && echo local || echo remote`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['local', 'remote']);
  });

  it('detects HTTPS remotes with userinfo', () => {
    const result = bash(
      `source '${lib}';
       host_update_remote_has_userinfo 'https://ghp_x@github.com/org/repo.git' && echo yes || echo no;
       host_update_remote_has_userinfo 'https://github.com/org/repo.git' && echo yes || echo no`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['yes', 'no']);
  });

  it('defaults to the public HTTPS repo when origin is local', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-update-remote-'));
    const app = join(root, 'bot');
    mkdirSync(app, { recursive: true });
    bash(`git init '${app}' && git -C '${app}' remote add origin '${root}/upstream'`);
    const result = bash(
      `source '${lib}'; APP_USER="$(id -un)"; unset GIT_REMOTE_URL; host_update_resolve_github_remote '${app}' "$APP_USER"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('https://github.com/chmieleski/trueskill-bot.git');
    rmSync(root, { recursive: true, force: true });
  });

  it('prefers the stored git-remote.url over a local origin', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-update-remote-'));
    const app = join(root, 'bot');
    const stored = join(root, 'git-remote.url');
    const credentialed = 'https://ghp_test@github.com/chmieleski/trueskill-bot.git';
    mkdirSync(app, { recursive: true });
    bash(`git init '${app}' && git -C '${app}' remote add origin '${root}/upstream'`);
    bash(`printf '%s\\n' '${credentialed}' >'${stored}'`);
    const result = bash(
      `source '${lib}'; APP_USER="$(id -un)"; GIT_REMOTE_FILE='${stored}'; host_update_resolve_github_remote '${app}' "$APP_USER"`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(credentialed);
    rmSync(root, { recursive: true, force: true });
  });

  it('repairs a local origin after git clone --local', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-update-remote-'));
    const live = join(root, 'bot');
    const stage = join(root, 'bot.next');
    const github = 'https://ghp_test@github.com/example/trueskill-bot.git';
    bash(`git init '${live}' && git -C '${live}' remote add origin '${github}'`);
    bash(`git clone --local '${live}' '${stage}'`);
    const before = bash(`git -C '${stage}' remote get-url origin`).stdout.trim();
    expect(before).toBe(live);

    const repair = bash(
      `source '${lib}'; APP_USER="$(id -un)"; host_update_ensure_github_origin '${stage}' '${github}' "$APP_USER"`,
    );
    expect(repair.status).toBe(0);
    expect(bash(`git -C '${stage}' remote get-url origin`).stdout.trim()).toBe(github);
    rmSync(root, { recursive: true, force: true });
  });

  it('upgrades a bare HTTPS origin when the resolved URL has userinfo', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-update-remote-'));
    const app = join(root, 'bot');
    const bare = 'https://github.com/example/trueskill-bot.git';
    const credentialed = 'https://ghp_test@github.com/example/trueskill-bot.git';
    bash(`git init '${app}' && git -C '${app}' remote add origin '${bare}'`);
    const repair = bash(
      `source '${lib}'; APP_USER="$(id -un)"; host_update_ensure_github_origin '${app}' '${credentialed}' "$APP_USER"`,
    );
    expect(repair.status).toBe(0);
    expect(bash(`git -C '${app}' remote get-url origin`).stdout.trim()).toBe(credentialed);
    rmSync(root, { recursive: true, force: true });
  });

  it('persists credentialed remotes to GIT_REMOTE_FILE', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-update-remote-'));
    const stored = join(root, 'git-remote.url');
    const credentialed = 'https://ghp_test@github.com/example/trueskill-bot.git';
    const result = bash(
      `source '${lib}'; GIT_REMOTE_FILE='${stored}'; host_update_persist_github_remote '${credentialed}'`,
    );
    expect(result.status).toBe(0);
    expect(readFileSync(stored, 'utf8').trim()).toBe(credentialed);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('host-update.sh artifact cut-over', () => {
  it('does not git pull or pnpm install on the host', () => {
    const sh = readFileSync(join(repoRoot, 'deploy/aws/host-update.sh'), 'utf8');
    expect(sh).not.toMatch(/git clone/);
    expect(sh).not.toMatch(/pnpm install/);
    expect(sh).not.toMatch(/pnpm --filter @dbz\/bot build/);
    expect(sh).not.toMatch(/git -C "\$\{APP_DIR\}" pull/);
  });

  it('requires stage dir and migrates after stop', () => {
    const sh = readFileSync(join(repoRoot, 'deploy/aws/host-update.sh'), 'utf8');
    expect(sh).toContain('host_update_stage_dir');
    expect(sh).toContain('systemctl stop dbz-bot');
    expect(sh).toMatch(/prisma migrate deploy/);
    expect(sh.indexOf('prisma migrate deploy')).toBeGreaterThan(
      sh.indexOf('systemctl stop dbz-bot'),
    );
  });

  it('runs deploy-commands from stage before stop', () => {
    const sh = readFileSync(join(repoRoot, 'deploy/aws/host-update.sh'), 'utf8');
    const deployIdx = sh.indexOf('apps/bot/dist/deploy-commands.js');
    const stopIdx = sh.indexOf('systemctl stop dbz-bot');
    expect(deployIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(deployIdx);
  });
});

/** jq `--parameters commands` block for the post-upload SSM deploy step. */
function ssmDeployCommandBody(yml: string): string {
  const deployStep = yml.indexOf('Deploy via SSM');
  expect(deployStep).toBeGreaterThan(-1);
  const jqStart = yml.indexOf('--parameters commands="$(jq -cn', deployStep);
  expect(jqStart).toBeGreaterThan(-1);
  const jqEnd = yml.indexOf("--query 'Command.CommandId'", jqStart);
  expect(jqEnd).toBeGreaterThan(jqStart);
  return yml.slice(jqStart, jqEnd);
}

describe('CI deploy SSM command', () => {
  it('does not stop dbz-bot before host-update.sh', () => {
    const yml = readFileSync(join(repoRoot, '.github/workflows/ci-cd.yml'), 'utf8');
    const from = yml.indexOf('Deploy via SSM');
    expect(from).toBeGreaterThan(-1);
    const chunk = yml.slice(from);
    expect(chunk).not.toMatch(/systemctl stop dbz-bot/);
  });

  // enabled in Task 7
  it('bootstraps from S3 instead of git pull', () => {
    const yml = readFileSync(join(repoRoot, '.github/workflows/ci-cd.yml'), 'utf8');
    const ssmBody = ssmDeployCommandBody(yml);

    expect(ssmBody).toContain('STAGE_DIR');
    expect(ssmBody).toMatch(/bot\/\$\{RELEASE_SHA\}\.tar\.gz/);
    expect(ssmBody).toMatch(/aws s3 cp.*RELEASE_BUCKET.*KEY/);
    expect(ssmBody).toMatch(/Unpacking to \$\{STAGE_DIR\}/);
    expect(ssmBody).toMatch(/HOST_UPDATE.*host-update\.sh/);
    expect(ssmBody).toMatch(/exec sudo.*HOST_UPDATE/);

    expect(ssmBody).not.toContain('pull --ff-only origin main');
    expect(ssmBody).not.toContain('Repairing local origin from /etc/dbz-bot/git-remote.url');
    expect(ssmBody).not.toMatch(/git-remote\.url/);

    expect(yml).not.toContain('pull --ff-only origin main');
    expect(yml).not.toContain('Repairing local origin from /etc/dbz-bot/git-remote.url');
  });

  it('does not pre-check the deploy lock from CI (host-update blocks on flock)', () => {
    const yml = readFileSync(join(repoRoot, '.github/workflows/ci-cd.yml'), 'utf8');
    expect(yml).not.toContain('lock-check');
  });

  it('waits up to 30 minutes for the deploy lock on the host', () => {
    const sh = readFileSync(join(repoRoot, 'deploy/aws/host-update.sh'), 'utf8');
    expect(sh).toContain('flock -w 1800 9');
    expect(sh).not.toContain('flock -n 9');
  });
});
