# Zero-downtime-prepare deploy — Design

**Date:** 2026-08-22  
**Status:** Approved (Approach 1 — stage clone + directory swap)  
**Scope:** `general` (host deploy / CI SSM; not game- or league-specific)  
**Extends:** `docs/superpowers/specs/2026-08-14-github-actions-cicd-design.md`

## Goal

Keep the live Discord bot running through `git pull`, `npm ci`, and `tsc`. Restart only when the new tree is ready. A failed prepare must leave the current process running. Successful deploys still have a **short** restart (Discord gateway reconnect, seconds), not overlapping two Node processes.

Today CI `systemctl stop`s before `host-update.sh`, and `host-update.sh` stops again before `npm ci`. `npm ci` deletes `node_modules` and `tsc` overwrites `dist/` that `ExecStart=/usr/bin/node dist/index.js` is using. A failed build after stop leaves the unit down (2026-08-22 v1.10.0).

## Non-goals

- Overlapping two Node processes on the same Discord token
- Building `dist/` or shipping a tarball from GitHub Actions
- Automatic rollback if the **new** process fails to start after swap
- Changing instance size, swap size, or systemd `WorkingDirectory` (`/home/ubuntu/bot`)
- Running `prisma migrate deploy` while the old process is still up
- OpenTofu / first-boot user-data rewrite (existing host uses repo `host-update.sh` after `git pull`)

## Decisions (locked)

| Topic                                    | Choice                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Approach                                 | Sibling stage at `/home/ubuntu/bot.next`; promote by directory swap                                                                  |
| Live tree during prepare                 | Do not `npm ci`, `prisma generate`, or `tsc` in `/home/ubuntu/bot`                                                                   |
| CI early stop                            | **Remove** `systemctl stop dbz-bot` from the SSM command in `.github/workflows/ci-cd.yml`                                            |
| CI `git pull`                            | **Keep** — loads the new `host-update.sh` into the live clone before it runs                                                         |
| `.env`                                   | `refresh-env.sh` writes into the **stage** (`APP_DIR=/home/ubuntu/bot.next`), not live                                               |
| Migrate                                  | `prisma migrate deploy` **after** `systemctl stop`, **before** swap (old Prisma client never sees the new schema)                    |
| `deploy-commands`                        | From the stage **before** stop (Discord API; bot process not required)                                                               |
| Promote                                  | `mv /home/ubuntu/bot` → `/home/ubuntu/bot.prev`; `mv /home/ubuntu/bot.next` → `/home/ubuntu/bot`; then `systemctl start`             |
| `bot.prev`                               | Delete only after `systemctl start` succeeds. If start fails, leave `bot.prev` for **manual** rollback. No automatic swap-back in v1 |
| Failed prepare (before stop)             | Leave live unit running; `rm -rf /home/ubuntu/bot.next`                                                                              |
| Failed migrate (after stop, before swap) | `systemctl start` the **old** live tree (`/home/ubuntu/bot` still the previous checkout)                                             |
| First boot / already stopped             | `systemctl stop` is a no-op; same promote path                                                                                       |
| RAM                                      | Bot + `npm ci` share t3.micro 1 GiB + existing 2 GiB swap (`ensure-swap.sh` unchanged)                                               |
| Lock                                     | Existing `/var/lock/dbz-bot-update.lock` still serializes deploys                                                                    |

## Architecture

```text
push to main (after Test + Release)
  → SSM (no systemctl stop)
  → git fetch/checkout/pull --ff-only origin main   # live source + host-update.sh
  → sudo bash host-update.sh
       1. ensure-swap
       2. git fetch in live (idempotent with CI pull)
       3. clone/reset /home/ubuntu/bot.next to origin/main
       4. refresh-env into bot.next/.env
       5. in bot.next: npm ci && npm run build && npm run deploy-commands
       6. systemctl stop dbz-bot
       7. in bot.next: npx prisma migrate deploy
       8. mv bot → bot.prev; mv bot.next → bot
       9. systemctl start dbz-bot
      10. rm -rf bot.prev   # only if start succeeded
```

systemd `WorkingDirectory=/home/ubuntu/bot` is unchanged. After swap the path is the new tree.

### Why a sibling clone

`npm ci` in the live directory unlinks `node_modules` under a running process (crash-loop). `tsc` rewrites `dist/index.js` the process already mapped. A second checkout keeps live `node_modules` and `dist/` intact until stop.

Local `git clone` from `/home/ubuntu/bot` into `bot.next`, then `git fetch origin` + `reset --hard origin/main` (or equivalent). Do not `npm ci` in live.

### Why migrate after stop

Additive columns are usually ignored by an old Prisma client, but a breaking migration would make the still-running old process talk to a new schema. Stop first, migrate, then promote. Migrate is seconds; `npm ci` (minutes) stays on the up path.

### Why CI still pulls the live tree

The instance must execute the **new** `host-update.sh`. Pulling source into live does not affect `node dist/index.js`. `host-update.sh` may fetch again; that is redundant and harmless.

## Components

### 1. `.github/workflows/ci-cd.yml` Deploy SSM body

Remove `systemctl stop dbz-bot || true`. Keep fetch / checkout / pull / `ensure-swap.sh` / `host-update.sh`. Update the comment: stop is inside `host-update.sh` only after the stage build succeeds.

### 2. `deploy/aws/host-update.sh`

Still root, `set -euo pipefail`, same flock.

Order:

1. `ensure-swap.sh` as today.
2. As `ubuntu`: `git fetch --all`, `checkout`, `pull --ff-only` in **live** `APP_DIR` (so a manual `sudo bash host-update.sh` without CI pull still gets `origin/main`).
3. `rm -rf` any leftover `APP_DIR.next` from a previous failed prepare.
4. Clone live → `${APP_DIR}.next` (path: `/home/ubuntu/bot.next` when `APP_DIR=/home/ubuntu/bot`). Reset that clone to `origin/$BRANCH`.
5. Source `/etc/dbz-bot/ssm.env` as today. Run `refresh-env.sh` with `APP_DIR` set to the **stage** (stage `.env` only).
6. Git HTTPS insteadOf + `npm install -g npm@11` as today (safe while live).
7. As `ubuntu` in the stage: `HUSKY=0 npm ci && npm run build && npm run deploy-commands`.
8. `systemctl stop dbz-bot || true`.
9. As `ubuntu` in the stage: `npx prisma migrate deploy`. On failure: `systemctl start dbz-bot` (old tree still at `APP_DIR`) and exit non-zero.
10. `mv APP_DIR APP_DIR.prev` then `mv APP_DIR.next APP_DIR`.
11. `systemctl start dbz-bot`. On failure: **do not** delete `APP_DIR.prev`; exit non-zero (manual: stop, `mv bot bot.bad`, `mv bot.prev bot`, start).
12. `rm -rf APP_DIR.prev`.
13. Touch `/var/lib/dbz-bot/ready` as today.

`update-bot.sh` stays a thin exec of `host-update.sh`.

**Leftover `${APP_DIR}.prev` at the start of `host-update`:**

- Unit **active** → `rm -rf` it (crash after start, before delete).
- Unit **inactive** → **abort** with restore copy: stop is already down; operator `mv bot bot.bad && mv bot.prev bot && systemctl start dbz-bot` (or `rm -rf bot.prev` if they intend to keep the new tree). Do not swap on top of an unresolved failed start.

### 3. Docs

- `infra/aws/README.md` — deploy no longer stops for `npm ci`; restart is the cut-over only.
- This spec extends the CI/CD design; do not rewrite that file except a one-line pointer if the restart bullet is now wrong.

## Error handling

| Failure                                    | Live bot                            | Disk                                       |
| ------------------------------------------ | ----------------------------------- | ------------------------------------------ |
| Stage `npm ci` / `tsc` / `deploy-commands` | Stays up                            | Remove `bot.next`                          |
| `systemctl stop` then migrate fails        | Restarted on **old** `bot`          | Remove `bot.next`                          |
| Swap succeeds, `systemctl start` fails     | Down until operator uses `bot.prev` | Keep `bot.prev`                            |
| SSM / script killed mid-`npm ci`           | Stays up                            | Leftover `bot.next` removed on next deploy |
| `bot.prev` exists and unit inactive        | Abort; no swap                      | Unchanged                                  |

## Testing (acceptance)

1. Successful deploy: journal shows `npm ci` **before** `Stopping dbz-bot`; downtime is stop→start only; `git -C /home/ubuntu/bot rev-parse HEAD` matches `main`; unit active.
2. Inject a stage `tsc` failure (or broken `package.json` on a throwaway commit): unit stays **active** on the previous SHA; no `bot` swap.
3. CI workflow on `main` does not contain `systemctl stop` before `host-update.sh`.
4. First-boot / already-stopped: `host-update.sh` still ends with an active unit (manual or existing cloud-init path).

## Open follow-ups (not v1)

- Automatic swap-back if `systemctl start` fails
- `nice`/`ionice` on stage `npm ci` if the live bot becomes sluggish under swap
- ~~Build artifacts in GitHub Actions to avoid `npm ci` on t3.micro~~ — **Done / superseded** by [`2026-09-21-artifact-deploy-design.md`](2026-09-21-artifact-deploy-design.md)
