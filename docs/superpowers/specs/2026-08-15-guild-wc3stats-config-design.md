# Guild wc3stats Config (env → DB) — Design

**Date:** 2026-08-15  
**Status:** Approved for implementation planning  
**Scope:** Move process-wide `WC3STATS_ENABLED` / `WC3STATS_MAP_PATTERN` / `WC3STATS_MAP_SHA1` into per-guild `GuildConfig`, applied only via the existing UDBR map preset command. **Slice 1** of guild/map personalization.

## Goal

Operators enable live wc3stats lobby import **per Discord server** with `/config set wc3stats_map_preset`, without editing `.env` or restarting the bot. Default guild state is **off** and **empty** (no UDBR inheritance until the preset runs). Process env keeps only HTTP timeout (and process secrets).

## Non-goals (this slice)

- Manual `/config set` for pattern, SHA-1, or a standalone enable toggle
- Env fallback for the three migrated keys (unlike create/mod roles)
- Accepting any wc3stats lobby when filter columns are empty
- Auto-migrating production guilds from current `.env` values
- Fat map presets (heroes, team names, OCR copy) — see **Deferred — Part 2** below
- Per-guild rating knobs, channels beyond what already exists, multi-map simultaneous filters

## Decisions (locked)

| Topic | Choice |
|-------|--------|
| Slice | **C** — env knobs + slot layout only; fat preset later |
| Enable UX | **D** — only `wc3stats_map_preset` turns import on (writes filter + slots + enabled) |
| Default (no DB override) | Import **off**; pattern/SHA-1 **unset**; no UDBR until preset |
| Storage shape | **Alt 1** — columns on `GuildConfig` (boolean + pattern string + comma-separated SHA-1 string) |
| Env fallback | **None** for the three keys; remove from process after ship |
| Reset | **A** — new `/config clear wc3stats` (full package); existing map/slot clears stay layout-only |
| SHA-1 column | Comma-separated string (same wire format as today’s env) |
| Timeout | `WC3STATS_TIMEOUT_MS` stays process-wide |
| Empty filter + enabled | Reject all maps (do not compile empty regex; do not accept-all) |
| Post-deploy | Production stays off until staff runs UDBR preset once per guild |

## Architecture

```text
/config set wc3stats_map_preset:udbr
  → assertCanConfigureBot
  → write GuildConfig: enabled=true, pattern+sha1 from UDBR constants
  → replace GuildWc3statsSlotMap with UDBR_WC3STATS_SLOT_MAP

/config clear wc3stats
  → enabled=false, pattern=null, sha1=null, delete all slot maps

/register_lobby, refresh, discord-sync, wc3stats-resolve
  → resolveGuildConfig(guildId)
  → enabled? compileWc3statsMapConfig(db pattern, db sha1 split)
  → never read WC3STATS_ENABLED / MAP_PATTERN / MAP_SHA1 from process
```

### Data model

Extend existing `GuildConfig`:

```prisma
model GuildConfig {
  // …existing fields…
  wc3statsEnabled     Boolean  @default(false)
  wc3statsMapPattern  String?
  wc3statsMapSha1     String?  // comma-separated map.sha1 allowlist
  wc3statsSlotMaps    GuildWc3statsSlotMap[]
}
```

| Field state | Meaning |
|-------------|---------|
| Row missing / `wc3statsEnabled=false` | Import off |
| `wc3statsMapPattern` / `Sha1` null or blank | No filter → no lobby matches (even if somehow enabled) |
| Preset applied | `enabled=true` + UDBR pattern + UDBR sha1 string + 12 slot rows |

### UDBR constants (code → DB copy)

Single module (or extend existing slot-map module) exports the preset payload:

| Piece | Source today | After |
|-------|--------------|--------|
| Slot layout | `UDBR_WC3STATS_SLOT_MAP` | unchanged; still written by preset |
| Pattern | env default `ultimate.?dragon.?ball.?reborn\|udbr` | named constant; preset **copies** into DB |
| SHA-1 | env / SSM default for 2.4f | named constant; preset **copies** into DB |

Updating constants in a deploy does **not** rewrite guilds that already ran the preset. Staff re-runs preset (or clear + preset) to pick up a new SHA-1.

### Resolution API

Extend `ResolvedGuildConfig` (and `resolveGuildConfig`):

```typescript
interface ResolvedGuildConfig {
  // …existing…
  wc3statsEnabled: boolean;
  wc3statsMapPattern: string | undefined;
  wc3statsMapSha1: string[]; // parsed from comma-separated column; empty if unset
}
```

- `wc3statsEnabled` — DB boolean only (default false)
- pattern — trimmed non-empty DB string or `undefined`
- sha1 — split/trim/lowercase like today’s env parser; empty array if unset
- **No** reads of `env.wc3statsEnabled` / `MapPattern` / `MapSha1`

Call sites that currently use `env.wc3statsEnabled` must pass `guildId` into resolve (or receive resolved flags from the command/handler). No guild → treat as disabled.

### Command UX

| Subcommand | Behavior |
|------------|----------|
| `set wc3stats_map_preset` (`udbr`) | Write enabled + pattern + sha1 + replace slot map (idempotent) |
| `clear wc3stats` | **New.** Full package reset: enabled false, pattern/sha1 null, delete all slot maps |
| `clear wc3stats_map` / `wc3stats_slot` | Unchanged — layout only; import/filter untouched |
| `view` | Show enabled, pattern, sha1 (`unset` if empty), plus existing slot section |

No `set` for enabled/pattern/sha1 alone in this slice.

Auth: unchanged (`Manage Guild` or hard-coded bot owner).

User-facing strings: English. Update staff doc `docs/discord/staff/a4-wc3stats-mapping.md` so ops no longer say “enable in the bot environment”.

### Process / AWS cleanup

**Remove** from app + docs + infra (same checklist as `env-aws-sync.mdc`):

- `WC3STATS_ENABLED`
- `WC3STATS_MAP_PATTERN`
- `WC3STATS_MAP_SHA1`

**Keep:** `WC3STATS_TIMEOUT_MS` in `env.ts`, `.env.example`, SSM, `refresh-env.sh`.

After deploy: run UDBR preset in each guild that needs import; then drop the three keys from `terraform.tfvars` / SSM on the next apply (unread).

### Modules (expected)

| Area | Change |
|------|--------|
| `prisma/schema.prisma` + migration | Three new columns |
| `src/services/guild/guild-config.ts` | Resolve + setters / clear package helper |
| UDBR preset constants | Pattern + sha1 next to slot map |
| `src/commands/config/config.ts` | Preset writes all fields; new clear; view lines |
| `wc3stats-resolve`, register/refresh/discord-sync | Resolve from guild, not env |
| `src/config/env.ts` + `.env.example` + rules | Drop three keys |
| `infra/aws/*` + `deploy/aws/refresh-env.sh` | Drop three SSM/env writer lines |
| Staff doc `a4` | Preset-only enable |
| Tests | Resolve defaults, preset write, clear package, call sites without env |

## Edge cases

| Case | Behavior |
|------|----------|
| Guild never configured | Import off; refresh/register paths that need wc3stats fail with disabled message |
| Slots already mapped, enabled still false | Import off until preset (or future enable UX) |
| Enabled true but pattern/sha1 cleared by bug/manual SQL | No lobby matches; do not accept-all |
| Invalid pattern string in DB | Same as today: error at compile (`MatchServiceError` / log); fail closed |
| DM / missing `guildId` | Config commands reject; import treated as off |
| Re-run preset after code SHA-1 change | Overwrites DB filter + slots with new constants |
| `clear wc3stats_map` while enabled | Import stays on; filter stays; slots empty → legacy index+1 behavior for roster mapping |

## Testing

1. Fresh guild / no row → `wc3statsEnabled === false`, pattern/sha1 empty; import paths refuse
2. Preset `udbr` → enabled true, pattern/sha1 match constants, slots = UDBR map; `view` shows them
3. `clear wc3stats` → off + null filter + zero slot rows; layout-only clears do not clear filter/enabled
4. Resolve never consults process env even if stale env vars are set in test process
5. Register/refresh/discord-sync use resolved guild flag
6. Build/`env` parse succeeds without the three removed variables

## Deferred — Part 2 (fat map presets / custom IHL)

Documented so context is not lost. **Out of scope for this slice;** separate spec when started.

### Intent

Presets per map so a guild can stand up a custom IHL already aligned with that map/game creators’ defaults — not only wc3stats filter + slots.

### Likely contents of a “fat” preset

| Concern | Today | Part 2 direction (tentative) |
|---------|-------|------------------------------|
| Team display names | Hardcoded `Z Fighters` / `Evil` in `team-names.ts` | Per guild or per selected map preset |
| Hero roster (1–12 names/colors) | Global `Hero` table | Per-map / per-guild catalog (or preset-seeded rows) without breaking global ratings assumptions |
| wc3stats filter + slot layout | This slice (DB copy from constants) | More presets beyond `udbr`; possibly shared preset registry |
| OCR / lobby copy | UDBR-oriented prompts and errors | Map-aware strings |
| Enable / select active map | Preset command writes columns | Explicit “active map preset” key vs copying blobs; multi-map support TBD |

### Open questions for Part 2 (do not resolve in Slice 1)

1. Are ratings **global across maps** or **isolated per map/guild** when heroes differ?
2. Is the hero catalog process-global, guild-scoped, or map-scoped with FK from matches?
3. Does selecting a preset **overwrite** guild branding, or store `activePresetId` and resolve at runtime?
4. Can one guild run two maps, or one active preset at a time?
5. Who authors presets — code constants only, or DB/admin-editable packs?

### Explicitly not started in Slice 1

- Changing `teamDisplayName` to read guild/map config
- Seeding or scoping `Hero` by guild/map
- Additional preset choices beyond `udbr`
- Manual pattern/SHA-1 editors (may arrive with Part 2 or a small follow-up if needed before fat presets)

## Rejected alternatives (Slice 1)

| Option | Why rejected |
|--------|----------------|
| Env fallback for enabled/pattern/sha1 | New guilds would silently inherit production UDBR; user wanted empty until preset |
| Preset key only (`wc3statsPreset=udbr`) without copying filter columns | User chose Alt 1 (explicit columns like env migration) |
| `clear wc3stats_map` as full package reset | Would change meaning of an existing layout-only command |
| Accept-all when filter empty | Unsafe for multi-guild / wrong-map imports |
| Standalone enable toggle without filter | User chose preset-as-package (D) |

## Tech debt / follow-ups (Slice 1 adjacent)

1. Optional later: `/config set wc3stats_pattern` / sha1 for non-UDBR without waiting for Part 2
2. One-shot ops note in deploy changelog: “run UDBR preset after this release”
3. Part 2 fat presets — see section above
