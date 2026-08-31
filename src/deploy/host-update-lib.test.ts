import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
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

describe('host-update.sh cut-over order', () => {
  it('runs npm ci before systemctl stop', () => {
    const sh = readFileSync(join(repoRoot, 'deploy/aws/host-update.sh'), 'utf8');
    const ciIdx = sh.indexOf('HUSKY=0 npm ci');
    const stopIdx = sh.indexOf('systemctl stop dbz-bot');
    expect(ciIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(ciIdx);
  });

  it('builds in a .next stage, not only in APP_DIR', () => {
    const sh = readFileSync(join(repoRoot, 'deploy/aws/host-update.sh'), 'utf8');
    expect(sh).toContain('host_update_stage_dir');
    expect(sh).toContain('npx prisma migrate deploy');
    expect(sh.indexOf('npm run build')).toBeGreaterThan(-1);
    expect(sh.indexOf('npx prisma migrate deploy')).toBeGreaterThan(
      sh.indexOf('systemctl stop dbz-bot'),
    );
  });

  it('pins live git fetch/checkout/pull to APP_DIR', () => {
    const sh = readFileSync(join(repoRoot, 'deploy/aws/host-update.sh'), 'utf8');
    expect(sh).toMatch(/git -C "\$\{APP_DIR\}" fetch --all/);
    expect(sh).toMatch(/git -C "\$\{APP_DIR\}" checkout "\$\{BRANCH\}"/);
    expect(sh).toMatch(/git -C "\$\{APP_DIR\}" pull --ff-only origin "\$\{BRANCH\}"/);
  });

  it('repairs stage origin after git clone --local before fetch', () => {
    const sh = readFileSync(join(repoRoot, 'deploy/aws/host-update.sh'), 'utf8');
    const cloneIdx = sh.indexOf('git clone --local "${APP_DIR}" "${STAGE_DIR}"');
    const ensureIdx = sh.indexOf('host_update_ensure_github_origin "${STAGE_DIR}"');
    const fetchIdx = sh.indexOf('git -C "${STAGE_DIR}" fetch origin');
    expect(cloneIdx).toBeGreaterThan(-1);
    expect(ensureIdx).toBeGreaterThan(cloneIdx);
    expect(fetchIdx).toBeGreaterThan(ensureIdx);
  });
});

describe('CI deploy SSM command', () => {
  it('does not stop dbz-bot before host-update.sh', () => {
    const yml = readFileSync(join(repoRoot, '.github/workflows/ci-cd.yml'), 'utf8');
    const marker = '"echo \\"==> deploy \\($sha)\\""';
    const from = yml.indexOf(marker);
    expect(from).toBeGreaterThan(-1);
    const chunk = yml.slice(from, yml.indexOf('echo "SSM command:"', from));
    expect(chunk).toContain('host-update.sh');
    expect(chunk).not.toMatch(/systemctl stop dbz-bot/);
  });

  it('quotes SSM echo lines so ==> is not a shell redirect', () => {
    const yml = readFileSync(join(repoRoot, '.github/workflows/ci-cd.yml'), 'utf8');
    expect(yml).toContain('"echo \\"==> deploy \\($sha)\\""');
    expect(yml).toContain('"echo \\"==> origin=${MASKED}\\""');
    expect(yml).not.toMatch(/"echo ==> /);
  });

  it('repairs a local origin from git-remote.url before git pull on the host', () => {
    const yml = readFileSync(join(repoRoot, '.github/workflows/ci-cd.yml'), 'utf8');
    expect(yml).toContain('Repairing local origin from /etc/dbz-bot/git-remote.url');
    expect(yml).toContain('remote set-url origin');
    expect(yml).not.toContain('GIT_REMOTE_URL: https://github.com/${{ github.repository }}.git');
    const repairIdx = yml.indexOf('Repairing local origin from /etc/dbz-bot/git-remote.url');
    const pullIdx = yml.indexOf('pull --ff-only origin main', repairIdx);
    expect(repairIdx).toBeGreaterThan(-1);
    expect(pullIdx).toBeGreaterThan(repairIdx);
  });

  it('does not pre-check the deploy lock from CI (host-update blocks on flock)', () => {
    const yml = readFileSync(join(repoRoot, '.github/workflows/ci-cd.yml'), 'utf8');
    expect(yml).not.toContain('lock-check');
    expect(yml).toContain('systemctl is-active --quiet dbz-bot');
  });

  it('waits up to 30 minutes for the deploy lock on the host', () => {
    const sh = readFileSync(join(repoRoot, 'deploy/aws/host-update.sh'), 'utf8');
    expect(sh).toContain('flock -w 1800 9');
    expect(sh).not.toContain('flock -n 9');
  });
});
