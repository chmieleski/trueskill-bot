# Hero Draft Panel + Action Log UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revise shipped WOS `/hero_draft` UX: pinned dual-column duel panel, per-action thread logs with next-captain pings, and `/hero_draft select` autocomplete hybrid.

**Architecture:** Keep existing turn engine and `HeroDraft` persistence. Extend `draft-ui.ts` for dual-column embeds + log line builders; wire pin + log posts in `draft-actions.ts`; add `select` subcommand on the slash command. No schema migration.

**Tech Stack:** TypeScript ESM, discord.js v14, Vitest, Prisma (read-only for this change).

## Global Constraints

- Scope: `general` (hero-draft UX) + existing `game:warcraft3_wos` emoji naming `wos_{objectId}`
- English-only user-facing strings
- Do not change turn sequence, timer rules, or lobby-prefill tech debt
- Conventional commits
- Spec: `docs/superpowers/specs/2026-09-20-wos-hero-ban-pick-draft-design.md` (panel + log revision)

## File map

| File                                       | Role                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `src/services/hero-draft/draft-ui.ts`      | Dual-column embed, BAN/PICK labels, log content builders, autocomplete filter helper |
| `src/services/hero-draft/draft-ui.test.ts` | UI unit tests                                                                        |
| `src/services/hero-draft/draft-actions.ts` | Pin on start; post action log after mutations; pass previous state for log           |
| `src/services/hero-draft/index.ts`         | Re-exports                                                                           |
| `src/commands/hero-draft/hero-draft.ts`    | `select` subcommand + hero autocomplete                                              |

---

### Task 1: Dual-column panel + log line builders (TDD)

**Files:**

- Modify: `src/services/hero-draft/draft-ui.ts`
- Modify: `src/services/hero-draft/draft-ui.test.ts`
- Modify: `src/services/hero-draft/index.ts`

**Interfaces:**

- Produces: `buildHeroDraftActionLogContent(previous, next, emojiMap, options?)` → `string`
- Produces: `filterAvailableHeroesForAutocomplete(state, query, limit?)` → `HeroPoolEntry[]`
- Produces: updated `buildHeroDraftEmbed` (dual-column inline fields, 🚫/✅ labels)

- [ ] **Step 1: Add failing tests** for dual-column fields, BAN/PICK in description, log line with next mention, autocomplete filter, field truncation helper if exported

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npm test -- src/services/hero-draft/draft-ui.test.ts`

- [ ] **Step 3: Implement UI builders**

Embed:

- Two inline team fields (Team 1 | Team 2)
- Each: Captain line, `🚫 Bans` list (one hero per line with emoji), `✅ Picks` list
- Description: `On the clock: <@id> · 🚫 BAN|✅ PICK · <t:…:R>`
- Extra field/footer tip: remaining count + `Select below or /hero_draft select`
- Truncate list strings at 1024 with `… +N more`

Log builder (compare previous → next):

- Detect last action: ban (incl skip/null), pick, complete, cancel
- Format: `🚫 **Team** banned <:e:> Name → ✅ <@next> **PICK**` (or terminal lines without next ping)
- Timeout: include `(timeout)` note
- `allowedMentions` handled by caller

Autocomplete helper: filter `availableHeroes(state)` by name/objectId substring, slice to 25

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Commit** `feat(hero-draft): dual-column panel and action log builders`

---

### Task 2: Pin panel + post action logs from actions

**Files:**

- Modify: `src/services/hero-draft/draft-actions.ts`

**Interfaces:**

- Consumes: `buildHeroDraftActionLogContent`, `buildHeroDraftEmbed`
- After every successful state-changing mutation (ban/pick/skip/timeout/cancel/complete): edit live message, then `channel.send` log

- [ ] **Step 1: On `startHeroDraft`** — after saving `liveMessageId`, `await message.pin().catch(...)`; if pin fails, return `{ draft, pinFailed: true }` or set a flag the command can surface (prefer return `{ draft, pinWarning?: string }`)

- [ ] **Step 2: Refactor `persistAndSchedule`** — accept `previousState` + optional `logKind` (`action` | `timeout` | `cancel`); after sync live message, post log via `buildHeroDraftActionLogContent` with `allowedMentions: { users: [nextCaptainId] }` when present

- [ ] **Step 3: Wire cancel** to use richer cancel log (keep English)

- [ ] **Step 4: Manual smoke via unit test of log builder already covered; optional light test mocking channel.send if easy — otherwise skip**

- [ ] **Step 5: Commit** `feat(hero-draft): pin live panel and post action logs`

---

### Task 3: `/hero_draft select` + autocomplete

**Files:**

- Modify: `src/commands/hero-draft/hero-draft.ts`
- Modify: `src/services/hero-draft/index.ts` (if new exports needed)

- [ ] **Step 1: Add subcommand** `select` with required autocomplete `hero` string (value = objectId string)

- [ ] **Step 2: Autocomplete** — resolve ACTIVE draft by `interaction.channelId` + guild; filter with `filterAvailableHeroesForAutocomplete`; respond name labels (emoji not in autocomplete name easily — use plain name + objectId)

- [ ] **Step 3: executeSelect** — find active draft in thread; load turn; `applyHeroBan` or `applyHeroPick`; ephemeral ack

- [ ] **Step 4: Update start reply** to mention pin warning when returned

- [ ] **Step 5: Commit** `feat(hero-draft): add select autocomplete command`

---

### Task 4: Format + verify

- [ ] **Step 1:** `npm run format:check` (fix with `npm run format` if needed)
- [ ] **Step 2:** `npm test -- src/services/hero-draft/`
- [ ] **Step 3:** `npm run typecheck`
