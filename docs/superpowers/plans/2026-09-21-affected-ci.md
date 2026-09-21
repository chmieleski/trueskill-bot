# Affected Turbo CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate Test and EC2 Deploy on Turborepo affected packages (NX-style), leaving semantic-release unchanged.

**Architecture:** A CI helper script resolves the git base and emits `bot` / `web` / `force_all` outputs. The workflow’s `affected` job feeds those into conditional Test steps and a Deploy `if:` gate.

**Tech Stack:** GitHub Actions, pnpm 9, Turborepo 2.x (`turbo ls --filter` + `--output=json`), bash.

## Global Constraints

- Scope: `general` (CI only)
- Do not change `.releaserc.json` or release job behavior
- Package names: `@dbz/bot`, `@dbz/web`, `@dbz/db`
- Force-all paths: `pnpm-lock.yaml`, root `package.json`, `turbo.json`, `.github/workflows/**`, `deploy/aws/**`
- English-only user-facing strings (N/A for CI logs; keep log messages in English)

---

### Task 1: Design spec

**Files:**

- Create: `docs/superpowers/specs/2026-09-21-affected-ci-design.md`

- [x] **Step 1: Write the approved design spec** (done in this change set)

---

### Task 2: `scripts/ci/affected.sh`

**Files:**

- Create: `scripts/ci/affected.sh`

**Interfaces:**

- Consumes env: `GITHUB_EVENT_NAME`, `GITHUB_BASE_REF`, `GITHUB_EVENT_BEFORE` (optional override `AFFECTED_BASE`)
- Produces stdout lines suitable for `GITHUB_OUTPUT`: `bot=`, `web=`, `force_all=`, `base=`
- Exit non-zero on missing base / turbo failure

- [x] **Step 1: Implement the script** (see `scripts/ci/affected.sh` in repo)

- [x] **Step 2: `chmod +x scripts/ci/affected.sh`**

- [x] **Step 3: Smoke-test locally**

Verified: web-only → `web`; bot-only → `bot`; db-only → `bot` (+ `@dbz/db` in turbo ls); lockfile/workflow → `force_all`; clean → none; `workflow_dispatch` → `force_all`.

---

### Task 3: Wire `.github/workflows/ci-cd.yml`

**Files:**

- Modify: `.github/workflows/ci-cd.yml`

- [x] **Step 1: Add `affected` job** before `test` (checkout fetch-depth 0, pnpm install, run script into `$GITHUB_OUTPUT`)

- [x] **Step 2: `test` needs `affected`; conditional generate / bot / web steps**

- [x] **Step 3: `deploy` `if:` also requires bot or force_all or workflow_dispatch**

- [x] **Step 4: `format` may stay independent (no need for affected outputs)**

---

### Task 4: Verification matrix

- [x] Web-only simulated base → web only
- [x] Bot path change → bot
- [x] Db path → bot via graph
- [x] Lockfile / workflow → force_all

---

## Spec coverage

| Spec requirement         | Task                         |
| ------------------------ | ---------------------------- |
| Turbo affected detection | Task 2                       |
| Force-all paths          | Task 2                       |
| Conditional test         | Task 3                       |
| Gated deploy             | Task 3                       |
| Release unchanged        | Task 3 (no edits to release) |
| Acceptance scenarios     | Task 4                       |
