# WOS2E / WOS2_BOT_V2 Report Parse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept only WOS2E v1 encrypted exports, decrypt/authenticate them, parse `WOS2_BOT_V2` / `schema=2` into an extended `Wos2BotReport`, and update fixtures, tests, and API docs.

**Architecture:** Port `examples/wos2/wos2_bot_decoder.js` into `wos2e-codec.ts` (container + crypto). `parseWos2BotReport` decrypts via the codec then parses V2 records. Export `encodeWos2eExport` for tests that need custom plaintext. No HTTP API shape change.

**Tech Stack:** TypeScript ESM, Vitest, existing `Wos2BotReportParseError` mapping.

**Spec:** `docs/superpowers/specs/2026-09-08-wos2e-v2-report-parse-design.md`

## Global Constraints

- Scope: `game:warcraft3_wos` (+ docs/tests that consume the parser)
- Format: **WOS2E only** — reject plaintext V1
- Keys: server-side only; do not ship to players
- Keep `parseWos2BotReport(rawText: string): Wos2BotReport` as the single entrypoint
- English error messages
- Conventional Commits

## File map

| File                                                     | Action                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| `src/games/warcraft3_wos/wos2e-codec.ts`                 | Create — decrypt/encode/MAC                                  |
| `src/games/warcraft3_wos/wos2e-codec.test.ts`            | Create — self-test + tamper cases                            |
| `src/games/warcraft3_wos/wos2-bot-report-parser.ts`      | Modify — decrypt first; V2 types/fields                      |
| `src/games/warcraft3_wos/wos2-bot-report-parser.test.ts` | Modify — encrypted fixture                                   |
| `src/games/warcraft3_wos/fixtures/wos2-bot-sample.txt`   | Replace with encrypted sample (or copy from examples)        |
| `src/games/warcraft3_wos/wos2-bot-report-roster.test.ts` | Modify — encode V2 fixtures                                  |
| `src/games/warcraft3_wos/wos2-bot-report-winner.test.ts` | Modify — encrypted / encoded fixtures                        |
| `src/services/match/match-waiting-approval.test.ts`      | Modify — encode V2 reportText                                |
| `docs/api/wos-match-upload.md`                           | Modify — document WOS2E / V2                                 |
| `examples/wos2/*`                                        | Keep as reference; optionally add to repo if still untracked |

---

### Task 1: WOS2E codec (TypeScript port)

**Files:**

- Create: `src/games/warcraft3_wos/wos2e-codec.ts`
- Create: `src/games/warcraft3_wos/wos2e-codec.test.ts`

**Interfaces:**

- Produces:
  - `decodeWos2eExport(text: string): { matchId: string; lines: string[] }`
  - `encodeWos2eExport(lines: string[], matchId: string): string` (test/helper; plaintext lines in, container text out)
  - Throw `Wos2BotReportParseError` (import from parser) **or** a codec error type that parser wraps — prefer throwing `Error` with clear messages and wrapping in parser to avoid circular import: codec throws `Wos2eCodecError`, parser maps to `Wos2BotReportParseError`.

**Circular import avoidance:** Define `Wos2eCodecError` in `wos2e-codec.ts`. Parser catches it and rethrows as `Wos2BotReportParseError`.

- [ ] **Step 1:** Create `wos2e-codec.ts` by porting `examples/wos2/wos2_bot_decoder.js` (ESM, named exports). Include `deriveKeys`, `makeContext`, `computeMac`, `decryptLine`, `extractContainer`, `decodeWos2eExport`, `encodeWos2eExport` (from `encodeForSelfTest`), `constantTimeEqual`. Max input `1024 * 1024`. Comment: do not distribute keys to players.

- [ ] **Step 2:** Write `wos2e-codec.test.ts` with self-test (encode → decode round-trip), Preload-wrapped decode, tampered cipher rejected, reordered seq rejected.

- [ ] **Step 3:** Run `npx vitest run src/games/warcraft3_wos/wos2e-codec.test.ts` — expect PASS.

- [ ] **Step 4:** Commit `feat(wos): add WOS2E R87M2 codec`

---

### Task 2: Parser V2 + decrypt entrypoint

**Files:**

- Modify: `src/games/warcraft3_wos/wos2-bot-report-parser.ts`
- Modify: `src/games/warcraft3_wos/fixtures/wos2-bot-sample.txt` (copy encrypted sample from examples)
- Modify: `src/games/warcraft3_wos/wos2-bot-report-parser.test.ts`

**Interfaces:**

- Consumes: `decodeWos2eExport`
- Produces: `WOS2_BOT_REPORT_FORMAT = 'WOS2_BOT_V2'`; extended types:

```ts
export type Wos2BotReportItemRate = {
  objectId: number;
  name: string;
  games: number;
  wins: number;
  winratePct: number;
};

export type Wos2BotReportPlayer = {
  // existing fields…
  lobbySlot: number | null;
  visualSlot: number | null;
  roundsPlayed: number;
  roundWins: number;
  roundLosses: number;
};

export type Wos2BotReport = {
  format: typeof WOS2_BOT_REPORT_FORMAT;
  externalId: string;
  schema: 2;
  teamsReorganized: boolean;
  team1Rounds: number | null;
  team2Rounds: number | null;
  playerCount: number | null;
  players: Wos2BotReportPlayer[];
  itemRates: Wos2BotReportItemRate[];
};
```

- [ ] **Step 1:** Update `parseWos2BotReport`:
  1. `extractWos2BotPayloadLines` (keep)
  2. Join or pass raw text into `decodeWos2eExport` — prefer decoding from **full rawText** (reference extracts via regex from whole file including Preload). Simplest: call `decodeWos2eExport(rawText)` first; on success parse `lines`; do not accept plaintext ID|… without WOS2E.
  3. Parse decrypted lines as V2 with structural checks aligned to the reference (`schema===2`, PLAYER/STATS/ITEMS triples, damage totals, ITEM_RATE winrate).
  4. Map codec errors → `Wos2BotReportParseError`.

- [ ] **Step 2:** Replace fixture with encrypted sample; rewrite parser tests for WorldEdit match + V2 fields; assert plaintext V1 throws; use `encodeWos2eExport` for synthetic cases (END mismatch, etc.).

- [ ] **Step 3:** Run `npx vitest run src/games/warcraft3_wos/wos2-bot-report-parser.test.ts src/games/warcraft3_wos/wos2e-codec.test.ts` — expect PASS.

- [ ] **Step 4:** Commit `feat(wos): parse WOS2E into WOS2_BOT_V2 reports`

---

### Task 3: Downstream test fixtures + API docs

**Files:**

- Modify: `src/games/warcraft3_wos/wos2-bot-report-roster.test.ts`
- Modify: `src/games/warcraft3_wos/wos2-bot-report-winner.test.ts`
- Modify: `src/services/match/match-waiting-approval.test.ts`
- Modify: `docs/api/wos-match-upload.md`
- Optionally add: `examples/wos2/` to git if still untracked

**Notes:**

- Real encrypted sample has **one player** — roster tests that need both teams must `encodeWos2eExport` multi-player V2 plaintext (update `format=WOS2_BOT_V2`).
- `game-item-catalog` only needs `objectId` + `name`; extra ITEM_RATE fields are fine.
- Winner tests: encode a two-team V2 report with round scores (sample alone is team1-only).

- [ ] **Step 1:** Update roster/winner/waiting-approval tests to use `encodeWos2eExport` or the encrypted fixture as appropriate.

- [ ] **Step 2:** Update `docs/api/wos-match-upload.md` for WOS2E / `WOS2_BOT_V2`.

- [ ] **Step 3:** Run `npx vitest run src/games/warcraft3_wos src/services/match/match-waiting-approval.test.ts src/api/wos-report.route.test.ts src/services/game/game-item-catalog.test.ts` — expect PASS.

- [ ] **Step 4:** Run `npm run format:check` and `npm run typecheck` — fix if needed.

- [ ] **Step 5:** Commit `feat(wos): migrate WOS fixtures and docs to WOS2E`

---

## Spec coverage checklist

| Spec requirement                 | Task           |
| -------------------------------- | -------------- |
| WOS2E only / reject V1           | 2              |
| TS codec port + keys server-side | 1              |
| Extended report fields           | 2              |
| Consumers unchanged behavior     | 3 (tests only) |
| API docs                         | 3              |
| Codec self-test / tamper         | 1              |
| Real sample fixture              | 2              |
