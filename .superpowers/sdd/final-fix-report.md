# GitHub Actions CI/CD — Review Fix Report

Date: 2026-08-14  
Branch: `feature/github-actions-cicd`  
Worktree: `/home/lesk/www/bot/.worktrees/github-actions-cicd`

## Changes

### Critical — CI workflow

Added `npx prisma generate` between `npm ci` and `npm test` in `.github/workflows/ci-cd.yml` so `@prisma/client` is generated on clean runners (Prisma 7 does not generate on install). Dummy env vars remain on `npm test` only.

### Important — AWS README

Documented OIDC provider one-per-account caveat and `tofu import` command under **CI/CD → One-time setup** in `infra/aws/README.md`.

## Workflow verification

Confirmed in `.github/workflows/ci-cd.yml`:

- `node-version: "22"` on test job
- `- run: npx prisma generate` after `npm ci`
- Dummy `env` block on `npm test` only
- Deploy gated: `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`

## Verification

### Test command (with local `.env` for `prisma.config.ts` / `DIRECT_URL`)

```bash
cd /home/lesk/www/bot/.worktrees/github-actions-cicd
npx prisma generate && \
DISCORD_TOKEN=ci CLIENT_ID=0 GUILD_ID=0 DATABASE_URL=postgresql://ci:ci@127.0.0.1:5432/ci GEMINI_API_KEY=ci \
npm test
```

Output:

```text
✔ Generated Prisma Client (v7.9.1) to ./../../node_modules/@prisma/client in 85ms

 Test Files  11 passed (11)
      Tests  80 passed (80)
   Duration  1.32s
```

Exit code: **0**

### CI simulation (`.env` renamed — no dotenv secrets)

```bash
cd /home/lesk/www/bot/.worktrees/github-actions-cicd
mv .env .env.bak.ci-test
npx prisma generate
```

Output:

```text
Failed to load config file ".../prisma.config.ts". Error: PrismaConfigEnvError: Cannot resolve environment variable: DIRECT_URL.
```

Exit code: **1**

**Concern:** On a GitHub runner (no `.env`), `npx prisma generate` still requires `DIRECT_URL` because `prisma.config.ts` calls `env('DIRECT_URL')` at config load. Follow-up may be needed (e.g. dummy `DIRECT_URL` on the generate step or optional config URL for generate-only runs).

## Commit

`0ed476b21706d3f4c9b0d37e15412d79443ad9c3` — fix(ci): generate Prisma client in CI and document OIDC import

---

## Follow-up — job-level dummy env for `prisma generate`

Date: 2026-08-14

### Change

Moved dummy env from the `npm test` step to **job-level** on the `test` job in `.github/workflows/ci-cd.yml`. Added `DIRECT_URL` (same dummy postgres URL as `DATABASE_URL`) so `npx prisma generate` succeeds on clean GitHub runners where `prisma.config.ts` requires `env('DIRECT_URL')`.

Deploy job unchanged; no Terraform changes.

### Verification (`.env` renamed — CI simulation)

```bash
env -u DISCORD_TOKEN -u CLIENT_ID -u GUILD_ID -u DATABASE_URL -u DIRECT_URL -u GEMINI_API_KEY \
  DISCORD_TOKEN=ci CLIENT_ID=0 GUILD_ID=0 \
  DATABASE_URL=postgresql://ci:ci@127.0.0.1:5432/ci \
  DIRECT_URL=postgresql://ci:ci@127.0.0.1:5432/ci \
  GEMINI_API_KEY=ci \
  bash -lc 'npx prisma generate && npm test'
```

Output:

```text
✔ Generated Prisma Client (v7.9.1) to ./../../node_modules/@prisma/client in 93ms

 Test Files  11 passed (11)
      Tests  80 passed (80)
   Duration  1.23s
```

Exit code: **0**

### Commit

(see git log — appended after commit)
