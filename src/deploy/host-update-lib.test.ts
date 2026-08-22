import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
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

  it('aborts when leftover prev exists and the unit is inactive', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-update-'));
    const app = join(root, 'bot');
    const prev = `${app}.prev`;
    mkdirSync(prev);
    const result = bash(`source '${lib}'; host_update_handle_leftover_prev '${app}' no`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing to deploy');
    expect(result.stderr).toContain(prev);
    expect(existsSync(prev)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('is a no-op when prev is absent', () => {
    const result = bash(`source '${lib}'; host_update_handle_leftover_prev '/no/such/bot' no`);
    expect(result.status).toBe(0);
  });
});

describe('host-update.sh cut-over order', () => {
  it('runs npm ci before systemctl stop', () => {
    const sh = readFileSync(join(repoRoot, 'deploy/aws/host-update.sh'), 'utf8');
    const ciIdx = sh.indexOf('npm ci');
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
});
