# Match Create Role Gate — Design

**Date:** 2026-08-13  
**Status:** Approved for implementation planning  
**Scope:** Restrict `/register_lobby` so only a configured Discord role can create PENDING matches (first test wave)

## Goal

For the first testing wave, only members with a configured Discord role can **create** match lobbies. Creating without that role (or without the env configured) must fail with a clear English error **before** OCR or DB writes.

## Non-goals

- Gating lobby edit / Start / Cancel on PENDING matches (host keeps those)
- Changing `MATCH_MOD_ROLE_ID` report/cancel auth
- Discord slash-command default permissions / role visibility at deploy time
- Multiple create roles or role lists

## Decisions (locked)

| Topic                        | Choice                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| Env                          | Separate `MATCH_CREATE_ROLE_ID` (can equal `MATCH_MOD_ROLE_ID` in `.env` for wave 1) |
| Unset / empty                | **Nobody** can create (hard lock)                                                    |
| Set                          | Only members whose role IDs include that value                                       |
| Scope                        | `/register_lobby` only                                                               |
| Architecture                 | Shared helpers in `match-auth.ts` + thin check in command                            |
| Discord native command perms | Out of scope                                                                         |

## Architecture

```text
/register_lobby
  → resolve guild member role IDs
  → assertCanCreateMatch({ memberRoleIds })
       if MATCH_CREATE_ROLE_ID unset/empty → reject (creation disabled)
       else if role not in memberRoleIds → reject
  → existing OCR → createPendingMatch → embed flow
```

### Modules

| File                                   | Change                                                         |
| -------------------------------------- | -------------------------------------------------------------- |
| `src/config/env.ts`                    | Parse optional `matchCreateRoleId` from `MATCH_CREATE_ROLE_ID` |
| `src/services/match-auth.ts`           | `canCreateMatch` / `assertCanCreateMatch`                      |
| `src/commands/lobby/register-lobby.ts` | Call assert early (before OCR / defer work that spends Gemini) |
| `.cursor/rules/scripts-and-env.mdc`    | Document the var                                               |
| `.env.example`                         | Placeholder for `MATCH_CREATE_ROLE_ID`                         |
| Tests                                  | Cover unset / wrong role / correct role                        |

Prefer asserting **before** expensive OCR. If the command already `deferReply`s first, still assert immediately after defer and before OCR so failures do not call Gemini.

### Env

| Var                    | Purpose                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `MATCH_CREATE_ROLE_ID` | Discord role ID required to run `/register_lobby`. Empty/unset → creation disabled for everyone |

Wave 1 ops: set `MATCH_CREATE_ROLE_ID` and `MATCH_MOD_ROLE_ID` to the same role ID if create and mod should be the same staff role.

### Auth semantics vs mod role

| Var                    | Empty behavior                          |
| ---------------------- | --------------------------------------- |
| `MATCH_MOD_ROLE_ID`    | Host-only manage (feature still usable) |
| `MATCH_CREATE_ROLE_ID` | Creation fully disabled                 |

### Error messages (English)

| Condition                  | Message                                                                |
| -------------------------- | ---------------------------------------------------------------------- |
| Env unset / empty          | `Match creation is disabled until MATCH_CREATE_ROLE_ID is configured.` |
| Env set, member lacks role | `Only members with the match creator role can register a lobby.`       |

Throw `MatchServiceError` (same pattern as manage-match auth) so the command maps it to a user-facing reply.

### Edge cases

| Case                                             | Behavior                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| Interaction outside guild / no member            | Treat as no roles → reject (create disabled or missing role, depending on env) |
| User has role + is not “host” yet                | Allowed; they become host of the new PENDING match                             |
| Host without create role managing existing lobby | Allowed (out of scope)                                                         |

## Testing

1. Unset `MATCH_CREATE_ROLE_ID` → `/register_lobby` fails with disabled message; no lobby created
2. Set role; user without role → fails with creator-role message
3. Set role; user with role → lobby creates as today
4. Unit: `canCreateMatch` for unset / mismatch / match

## Out of scope / later

- Soft-open mode (empty = anyone can create) if public launch needs it
- Discord Integrations UI role lock on the slash command itself
