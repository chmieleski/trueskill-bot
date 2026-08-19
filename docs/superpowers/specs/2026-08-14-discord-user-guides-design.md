# Discord User Guides — Design

**Date:** 2026-08-14  
**Status:** Approved  
**Scope:** Copy-paste Discord posts explaining the bot for players and staff

## Goal

Ship a series of short English Discord posts (simple language) so players know how to use the bot, and staff know how to configure/moderate it — split across a public channel and a staff-only channel.

## Locked decisions

| Topic          | Choice                                                                 |
| -------------- | ---------------------------------------------------------------------- |
| Language       | English                                                                |
| Format         | One short post per file (~≤1800 chars), ready to paste                 |
| Structure      | Hybrid: player journey + cheat sheet; staff setup + mods + cheat sheet |
| Public channel | 7 posts (`docs/discord/public/`)                                       |
| Staff channel  | 5 posts (`docs/discord/staff/`)                                        |
| Tone           | Very simple; no OpenSkill μ/σ jargon; public “ki” only                 |
| Team names     | Z Fighters (1–6) / Evil (7–12)                                         |
| Out of scope   | AWS, Terraform, `.env`, deploy internals                               |

## Deliverables

- `docs/discord/README.md` — posting order
- `docs/discord/public/01` … `07`
- `docs/discord/staff/a1` … `a5`

## Non-goals

- In-bot help command
- Portuguese translations (can add later)
- Changing slash command descriptions
