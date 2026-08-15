# Database backup & local restore

**Scope:** `general` (ops; not game-specific)

## Goal

Safety-net dump of hosted production Postgres before risky migrations, plus a helper that restores a dump into local Docker only.

## Design

- **`scripts/db-backup.sh`** / `npm run db:backup`
  - Source: same resolution as `db:clone` (`PROD_DIRECT_URL` → `.env` / `.env.prod` `DIRECT_URL`). Reject port 6543 and localhost.
  - Client: Docker `postgres:17` `pg_dump` (must be ≥ hosted major).
  - Contents: public schema + data, including `_prisma_migrations`, `--no-owner --no-privileges`.
  - Output: `.local/backups/prod-YYYYMMDD-HHMMSS.sql.gz` (gzip). Never print passwords.
- **`scripts/db-restore-local.sh`** / `npm run db:restore -- [path]`
  - Restores into local Compose Postgres only (`dbz-bot-postgres`). Never writes to hosted URLs.
  - Accepts `.sql` or `.sql.gz`. Default file: newest matching `prod-*.sql.gz` under `.local/backups/`.
  - Flow: start local Postgres → drop/create `dbzbot` → stream dump into `psql` (no `prisma migrate`; schema is in the dump).

## Non-goals

- Automated restore to production
- Custom-format (`-Fc`) dumps
- Scheduled/CI backups
