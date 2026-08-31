# `/hero_matches` — Design

**Date:** 2026-08-31  
**Status:** Approved  
**Scope:** `general` (WOS hero match history)  
**Related:** [`2026-08-31-hero-recent-games-and-players-design.md`](./2026-08-31-hero-recent-games-and-players-design.md)

## Goal

Add `/hero_matches` — a paginated list of all completed WIN/LOSS match ids for a **player + hero** combo (defaults to the invoking user).

## Locked decisions

| Topic                   | Choice                                                                          |
| ----------------------- | ------------------------------------------------------------------------------- |
| Command shape           | Single `/hero_matches` — required `hero`, optional `user`/`nick` (default self) |
| Pagination              | 10 per page, Prev/Next buttons (match history UX)                               |
| Data                    | On-read from `MatchPlayerStats` via shared `hero-stats` loaders                 |
| Rank reset              | Respected (same as `/hero` player view)                                         |
| Window filter           | Full history only (no `last10` option)                                          |
| Match types             | Completed WIN/LOSS only (no cancelled/griefer)                                  |
| Visibility              | Public for self; deferred reply for other-player lookups                        |
| Game gate               | `postMatchStats === 'wos2_bot_v1'`                                              |
| Button custom id prefix | `hm:`                                                                           |

## Non-goals (v1)

- League-wide “anyone on this hero” list
- Stats columns beyond W/L + date + match id
- Env / AWS changes
