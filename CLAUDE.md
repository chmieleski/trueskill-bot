# DBZ WC3 Bot — Project Context

Discord bot for managing **5v5 matches** on a custom **Dragon Ball Z Warcraft III** map. Ten unique heroes are tied to lobby slots/colors. Features player ranking using **OpenSkill** algorithm with global and hero-specific ratings.

## Stack

- **Node.js + TypeScript** (ESM, `"type": "module"`)
- **discord.js v14** — Slash Commands, REST API
- **Prisma** — ORM for PostgreSQL
- **Supabase** — PostgreSQL database (free tier)
- **dotenv** — env vars from `.env`
- **tsx** — dev runtime with hot-reload (no build in dev)

## Language

All user-facing strings, logs, command names/descriptions, and errors must be in **English**.

## Project Structure

```
src/
├── index.ts              # Bootstrap: load commands → deploy → load events → login
├── deploy-commands.ts    # Standalone deploy script (CI/manual)
├── config/env.ts         # Validated env (DISCORD_TOKEN, CLIENT_ID, GUILD_ID, DATABASE_URL)
├── lib/prisma.ts         # Prisma client singleton
├── client/create-client.ts
├── types/command.ts      # Command interface { data, execute }
├── handlers/
│   ├── load-commands.ts  # Recursive auto-load from src/commands/**
│   ├── load-events.ts    # Auto-load from src/events/**
│   └── register-commands.ts  # REST guild command registration
├── commands/             # One file per command, grouped by domain (e.g. lobby/)
├── events/               # ready.ts, interaction-create.ts
└── services/             # Reserved: WebSocket 24/7, Cron Jobs, ranking
```

## Database Schema

### Tables
- **Player** — Identified by `username` (battletag/nick), `discordId` optional (Ghost Profile pattern)
- **PlayerRating** — Global skill rating (μ/σ) — separated for SRP
- **Hero** — 10 heroes (id 1-10), tied to lobby slots
- **PlayerHeroRating** — Hero-specific ratings (μ/σ, matchesPlayed)
- **Match** — 5v5 game sessions with status tracking
- **MatchPlayer** — Player participation (team, slot, hero, result)

### Key Design Decisions
- **Username as primary identifier** — Players tracked by battletag, not Discord ID
- **Rating tables separated** — Global and hero ratings in separate tables (SOLID/SRP)
- **Slot determines team/hero** — Slots 1-5 = Team A, 6-10 = Team B; Slot = Hero ID
- **No DRAW in game** — MatchResult has DRAW for flexibility but game only uses WIN/LOSS

## Adding a Slash Command

1. Create `src/commands/<domain>/<name>.ts` exporting `data` + `execute`
2. Use `SlashCommandBuilder` for `data`
3. For operations >3s, call `await interaction.deferReply()` immediately, then `editReply()`
4. In dev, commands auto-register on restart (`AUTO_DEPLOY_COMMANDS` defaults to true)

```typescript
export const data = new SlashCommandBuilder()
  .setName('register_lobby')
  .setDescription('Register a DBZ 5v5 match lobby (work in progress)');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  await interaction.editReply('Analyzing Ki...');
}
```

## Scripts & Environment

| Script | Purpose |
|--------|---------|
| `npm run dev` | Dev mode — tsx watch, auto-restart, auto-deploy commands |
| `npm run build` | Generate Prisma client + compile TypeScript |
| `npm start` | Production — runs from `dist/` |
| `npm run deploy-commands` | Manual guild command deploy |
| `npm run db:migrate` | Create and apply Prisma migration |
| `npm run db:push` | Push schema to database without migration |
| `npm run db:studio` | Open Prisma Studio GUI |
| `npm run db:generate` | Regenerate Prisma client |

### Environment Variables
- `DISCORD_TOKEN` — Bot token
- `CLIENT_ID` — Discord application ID
- `GUILD_ID` — Dev server ID
- `DATABASE_URL` — Supabase pooled connection (port 6543)
- `DIRECT_URL` — Supabase direct connection (port 5432)
- `NODE_ENV` — `development` or `production`
- `AUTO_DEPLOY_COMMANDS` — Auto-register commands on startup

## Conventions

- Match existing patterns: named exports (`data`, `execute`, `name`, `once`) — no default exports required
- ESM imports use `.js` extension in TypeScript source
- Graceful shutdown: `client.destroy()` on SIGINT/SIGTERM
- Prisma client via `src/lib/prisma.ts` singleton — never create new instances directly
