# Task 7: Manual smoke checklist — report

**Status:** DONE_WITH_CONCERNS (requires human Discord verification)

Automated agents cannot run Discord slash-command smoke tests in this environment.

## Operator checklist (run after merge/deploy)

1. Apply migration if not applied: `npm run db:migrate` (or `prisma migrate deploy`) on an environment with DATABASE_URL
2. Restart bot (`npm run dev`) so `/config` deploys
3. No GuildConfig row + env create/mod set → `/config view` shows source `env`; create/mod auth works
4. `/config set create_role @Role` as Manage Guild → success; `view` shows `database` for create
5. Owner ID `723326675647070218` can `/config` without Manage Guild
6. Random member without Manage Guild → permission error
7. Neither DB nor env create → `/register_lobby` → `Match creation is disabled until a create role is configured.`
8. After DB create role set, member with role can register; without cannot
9. DM `/config` → server-only message

## Automated verification already done

- Unit tests: match-auth, guild-config (59 tests green in worktree)
- Code wiring complete on feature/guild-config-roles

