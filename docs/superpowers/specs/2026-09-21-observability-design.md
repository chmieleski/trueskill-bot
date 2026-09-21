# Process observability (Discord ops + agent HTTP) — Design

**Date:** 2026-09-21  
**Status:** Approved for implementation  
**Scope:** `general` (process/ops — not game-specific)

## Goal

Give humans a light Discord ops signal when the bot process is unhealthy or lifecycle-changing, and give agents (Cursor / SSH) a secured on-box HTTP snapshot of load and health — without standing up CloudWatch or a full APM stack in v1.

## Non-goals (v1)

- CloudWatch Logs / dashboards / alarms
- OpenTelemetry / Prometheus / Grafana (tracked as GitHub tech debt — see Related)
- Mirroring every `log.error()` / `log.warn()` into Discord (log firehose)
- Hourly “still alive” activity pulse embeds
- Changing WOS league API auth or gating observability on `API_ENABLED`
- Multi-instance aggregation (single EC2 process assumed)

## Decisions (locked)

| Topic | Choice |
| ----- | ------ |
| Audience | Humans (Discord) + agent (HTTP) |
| Human surface | Discord ops embeds — lifecycle + health + crashes only |
| Agent surface | Dedicated obs HTTP listener, independent of WOS `API_ENABLED` |
| Auth | Default bind `127.0.0.1`; Bearer `OBS_TOKEN` required when bind is not loopback |
| Ops channel config | Env `OPS_ALERT_CHANNEL_ID` fallback + per-guild `GuildConfig.opsAlertChannelId` fan-out |
| Logs | Existing pino → stdout → journald unchanged for deep digs |
| Infra | Full env → OpenTofu SSM + `refresh-env.sh` sync for every new bot-read key |

## Architecture

```text
Discord client ──► Ops alerter ──► Ops Discord channel(s)
Health sampler ──► Metrics registry ──► Obs HTTP (/health, /status)
                └──► Ops alerter (threshold breaches)
pino stdout ──► journald (systemd)
```

### Modules

| Unit | Responsibility |
| ---- | ---------------- |
| Metrics registry | In-process gauges/counters: startedAt, Discord ready, sampler readings, minimal interaction/error counters |
| Health sampler | Periodic: RSS/heap, event-loop delay p99, `SELECT 1` DB ping |
| Channel resolver | Union of env channel + all configured guild ops channels; dedupe by channel id |
| Ops alerter | Post embeds; per-alert-type cooldown; never block process exit |
| Obs HTTP | `GET /health`, `GET /status`; Bearer check when non-loopback |

Reuse `extractBearerToken` from `src/api/auth.ts`. Do **not** mount obs routes on the WOS HTTP server.

## HTTP

Defaults: `OBS_ENABLED=true`, `OBS_BIND=127.0.0.1`, `OBS_PORT=8790`.

### `GET /health`

- **200** `{ "ok": true }` when process is up, Discord `client.isReady()`, and last DB sample is ok (or not yet sampled).
- **503** `{ "ok": false, "reason": "..." }` otherwise.

### `GET /status`

JSON snapshot for agents:

```json
{
  "version": "1.x.y",
  "uptimeSec": 12345,
  "discord": { "ready": true, "pingMs": 42, "guildCount": 3 },
  "process": { "pid": 1, "rssMb": 180, "heapUsedMb": 90, "eventLoopP99Ms": 12 },
  "db": { "ok": true, "latencyMs": 4 },
  "api": { "wosEnabled": true },
  "counters": { "interactionsTotal": 0, "unhandledRejections": 0 },
  "sampledAt": "ISO-8601"
}
```

Counters stay minimal in v1 (cheap hooks only; no request tracing).

### Auth rules

- Loopback bind: token optional (accepted if `OBS_TOKEN` set and provided).
- Non-loopback bind: missing/invalid Bearer → **401**.
- Obs token is process-wide (`OBS_TOKEN`), never a league API token.

## Discord alert catalog

| Event | Trigger |
| ----- | ------- |
| Boot / Ready | After Discord ready |
| Disconnect | Discord WS disconnect / invalid session |
| Shutdown | SIGINT / SIGTERM path (best-effort) |
| Crash | `uncaughtException` (best-effort before exit) |
| Unhandled rejection | Rate-limited (counts toward counters; Discord on cooldown) |
| High RSS | `rssMb >= OBS_RSS_MB_WARN` (default 512), cooldown |
| Event-loop lag | p99 ms >= `OBS_EVENT_LOOP_MS_WARN` (default 200), cooldown |
| DB unhealthy | Ping fail, cooldown; recovery embed when OK again |

Cooldown per alert type: **10–15 minutes**. No hourly pulse. Application `log.error()` lines stay in journald only.

## Config

### Env

| Key | Default | Notes |
| --- | ------- | ----- |
| `OBS_ENABLED` | `true` | When false, no obs HTTP / sampler / Discord alerter |
| `OBS_BIND` | `127.0.0.1` | |
| `OBS_PORT` | `8790` | Distinct from `API_PORT` (8787) |
| `OBS_TOKEN` | empty | Required off-loopback |
| `OPS_ALERT_CHANNEL_ID` | empty | Process-wide fallback destination |
| `OBS_RSS_MB_WARN` | `512` | |
| `OBS_EVENT_LOOP_MS_WARN` | `200` | |
| `OBS_SAMPLE_INTERVAL_MS` | `15000` | |

### Guild

- `GuildConfig.opsAlertChannelId String?`
- `/config set ops_channel` (+ show in config view)

### AWS / OpenTofu (mandatory)

Every new bot-read key must update:

1. `src/config/env.ts`
2. `.env.example` + `.cursor/rules/scripts-and-env.mdc`
3. `infra/aws/variables.tf`, `ssm.tf`, `terraform.tfvars.example` (`OBS_TOKEN` SecureString; empty optionals → `__EMPTY__`)
4. Explicit `echo` lines in `deploy/aws/refresh-env.sh`
5. Ops: set tfvars → `tofu apply` → refresh-env / next deploy

## Bootstrap

- Start sampler + obs HTTP after Discord client is available (post-login / ready).
- Stop sampler + obs HTTP on shutdown alongside WOS API stop.
- Hook existing process handlers to alerter without replacing fatal exit behavior.

## Testing

- Channel resolver (env / guild / both / dedupe)
- Auth (loopback vs non-loopback)
- `/health` and `/status` shapes from stubs
- Alerter cooldown
- Pure threshold helpers

## Related

- Tech debt: OpenTelemetry + Prometheus + Grafana (GitHub issue linked after open)
- Existing logger: `src/lib/logger.ts` (pino)
- Existing WOS API: `src/api/http-server.ts` (unchanged for obs)
