# Guild Config Roles via `/config` — Design

**Date:** 2026-08-14  
**Status:** Approved for implementation planning  
**Scope:** Move `MATCH_CREATE_ROLE_ID` and `MATCH_MOD_ROLE_ID` from env-only into per-guild DB config, editable via slash command (small step toward full per-server personalization)

## Goal

Operators can **view** and **set** match create/mod Discord roles with `/config`, without editing `.env` or restarting the bot. Env remains a **fallback** until each field is first written for that guild.

## Non-goals

- Clearing / unsetting roles via command (set-only in this slice)
- Explicit feature toggles (on/off for match creation, etc.) — tracked as tech debt
- Reset-to-env / migrate-back-to-env command
- Full per-server personalization (channels, copy, rating knobs, etc.)
- Changing create/mod **semantics** (empty create = nobody creates; empty mod = host-only)
- Discord native slash-command permission locks as a substitute for bot-stored roles
- Multi-bot-owner list or role-based “bot admin” beyond Manage Guild + hard-coded owner ID

## Decisions (locked)

| Topic                 | Choice                                                             |
| --------------------- | ------------------------------------------------------------------ |
| Scope                 | Only `matchCreateRoleId` and `matchModRoleId`                      |
| Storage               | Postgres `GuildConfig` keyed by `guildId`                          |
| Precedence            | Non-null DB field wins; otherwise env fallback                     |
| Set behavior          | Command **sets** only (never writes `null`)                        |
| Clear / disable       | Out of scope; future feature toggles instead of empty-field as UX  |
| Command               | `/config` with `view` + `set create_role` / `set mod_role`         |
| Who may run `/config` | Discord **Manage Guild**, **or** user ID `723326675647070218`      |
| Owner ID storage      | Constant in code (not required env)                                |
| Resolve key           | Always `interaction.guildId` (not deploy `GUILD_ID`)               |
| Auth for matches      | Same create/mod rules; callers pass resolved IDs into `match-auth` |

## Architecture

```text
/config view|set
  → assertCanConfigureBot (Manage Guild | owner Discord ID)
  → guild-config service (read/upsert GuildConfig)

/register_lobby, /match, lobby/match buttons
  → resolveGuildConfig(guildId)
       per field: DB non-null ? DB : env
  → assertCanCreateMatch / assertCanManageMatch({ …, roleIds from resolve })
```

### Data model

```prisma
model GuildConfig {
  guildId            String   @id
  matchCreateRoleId  String?
  matchModRoleId     String?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
}
```

| Field state    | Meaning                                                    |
| -------------- | ---------------------------------------------------------- |
| Row missing    | Both fields treated as unset → env only                    |
| Field `null`   | That field not yet set via `/config` → env fallback        |
| Field non-null | Canonical value for that guild; env ignored for that field |

### Resolution

`resolveGuildConfig(guildId)` returns effective IDs plus optional source metadata for `view`:

```typescript
type RoleConfigSource = 'database' | 'env' | 'unset';

interface ResolvedGuildConfig {
  matchCreateRoleId: string | undefined;
  matchModRoleId: string | undefined;
  matchCreateRoleSource: RoleConfigSource;
  matchModRoleSource: RoleConfigSource;
}
```

- Effective ID = DB string if non-null/non-empty, else trimmed env, else `undefined`
- Source = `database` | `env` | `unset` accordingly

### Modules

| File                                   | Change                                                            |
| -------------------------------------- | ----------------------------------------------------------------- |
| `prisma/schema.prisma`                 | Add `GuildConfig`                                                 |
| Migration                              | Create table                                                      |
| `src/services/guild-config.ts`         | `resolveGuildConfig`, `setMatchCreateRole`, `setMatchModRole`     |
| `src/commands/config/config.ts`        | `/config view` / `/config set`                                    |
| `src/services/match-auth.ts`           | Accept role IDs as arguments (no direct `env` read for these two) |
| Call sites                             | Resolve once per interaction, pass into auth helpers              |
| `.env.example` / `scripts-and-env.mdc` | Document env as fallback until first `/config set`                |
| Tests                                  | Resolve precedence, config auth, match-auth with injected IDs     |

### Command UX

| Subcommand        | Behavior                                                             |
| ----------------- | -------------------------------------------------------------------- |
| `view`            | Ephemeral summary: create + mod (role mention or `unset`) and source |
| `set create_role` | Required Role option → upsert `matchCreateRoleId`                    |
| `set mod_role`    | Required Role option → upsert `matchModRoleId`                       |

- Guild-only (reject DMs)
- All user-facing strings in English
- Idempotent set (same role again → success)

### `/config` authorization

Allow if:

1. `interaction.user.id === '723326675647070218'`, or
2. Member has Discord permission **Manage Guild**

Otherwise: short English deny message. No dependency on create/mod roles (avoids bootstrap deadlock).

### Match auth (unchanged rules, new source)

| Resolved create role | Behavior                      |
| -------------------- | ----------------------------- |
| `undefined`          | Nobody can create             |
| Set                  | Member must have that role ID |

| Resolved mod role | Behavior                         |
| ----------------- | -------------------------------- |
| `undefined`       | Host-only manage                 |
| Set               | Host or member with that role ID |

Update disabled-create copy to not name the env var:

> `Match creation is disabled until a create role is configured.`

(Missing-role message can stay: `Only members with the match creator role can register a lobby.`)

### Env fallback

| Var                    | Role after this change                          |
| ---------------------- | ----------------------------------------------- |
| `MATCH_CREATE_ROLE_ID` | Fallback until guild has DB `matchCreateRoleId` |
| `MATCH_MOD_ROLE_ID`    | Fallback until guild has DB `matchModRoleId`    |

Keep parsing in `src/config/env.ts`. Do not remove vars in this slice.

## Edge cases

| Case                                    | Behavior                                          |
| --------------------------------------- | ------------------------------------------------- |
| DM / no guild                           | Reject configure and any resolve that needs guild |
| Role deleted in Discord, ID still in DB | ID still used for membership checks               |
| Partial DB (only create set)            | Create from DB, mod from env (or unset)           |
| Bot restart                             | No change — DB is source of truth once set        |

## Testing

1. No `GuildConfig` row + env set → resolve uses env; `view` shows `env`
2. `/config set create_role` → subsequent resolve/create auth uses DB; `view` shows `database` for create
3. Mod still from env until `set mod_role`
4. Manage Guild can `/config`; owner ID can without Manage Guild; random member cannot
5. Create with neither DB nor env → disabled message (new wording)
6. Unit: `match-auth` with injected IDs only

## Tech debt (explicit)

Document and defer:

1. **Feature toggles** — e.g. enable/disable match creation without abusing empty role fields
2. **Clear / unset** — clear a role field (and define whether env resumes)
3. **Reset to env** — drop DB override for a field
4. **Broader `GuildConfig`** — more per-server settings on the same table/row pattern

## Out of scope / later

- Soft-open create (empty = anyone may create)
- Multiple create/mod roles
- Admin role stored in DB instead of Manage Guild + owner ID
