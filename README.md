# hct-pulse

Uptime & latency monitoring for Human-Centered-Tech services. Currently watching **Catholic Owned** (production + staging); designed to grow — add a service by adding endpoints to `targets.json`.

**Dashboard:** https://human-centered-tech.github.io/hct-pulse/

## How it works

- A GitHub Actions cron (`.github/workflows/probe.yml`) runs `scripts/probe.mjs` every ~5 minutes from a GitHub runner.
- Each endpoint in `targets.json` is fetched and classified:
  - **up** — accepted HTTP status, faster than `warnMs`
  - **slow** — accepted status but slower than `warnMs`
  - **down** — unaccepted status, error/timeout, or slower than `critMs`
- Results land in `docs/data/` (committed back to the repo, 30-day history) and the GitHub Pages dashboard renders them: status cards, 24-hour latency sparklines, uptime %, and the `x-railway-edge` header so Railway POP issues are identifiable at a glance.
- **Hourly multi-vantage checks** via check-host.net probe key URLs from several geographic nodes — this catches path-specific problems (like a single bad anycast edge POP) that a single vantage point misses entirely.

## Alerts

Two consecutive bad probes (~10 min) trigger a state change:

1. **GitHub issue** labeled `incident` is opened (and auto-closed on recovery). Watch the repo to get GitHub's native email/push notifications.
2. **Optional email via Resend:** set the `RESEND_API_KEY` repo secret and `ALERT_EMAILS` (comma-separated) + `ALERT_FROM` repo variables.

Set `"alert": false` on an endpoint (e.g. staging) to track it on the dashboard without alerting.

## Adding a service

Append to `targets.json`:

```json
{
  "name": "My New Service",
  "endpoints": [
    { "id": "svc-api", "name": "API health", "url": "https://api.example.com/health", "warnMs": 1500, "critMs": 6000 }
  ]
}
```

Optional per-endpoint fields: `acceptStatus` (array of OK statuses, default `[200]`), `timeoutMs` (default 30000), `method`, `headers`, `alert`.

## Run locally

```
node scripts/probe.mjs        # probes everything, writes docs/data/
```

Born 2026-07-01 from the Railway `mia1` edge → `us-west2` backhaul incident, which took Catholic Owned from 0.3s to 6–25s TTFB while every conventional metric (CPU, memory, deploy status, Railway status page) looked green.
