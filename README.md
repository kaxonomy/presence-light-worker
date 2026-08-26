# Presence Light Worker

Cloudflare Worker backend for one persisted `available`/`busy` state per room. Each room maps to one SQLite-backed Durable Object, which owns HTTP mutations and hibernatable WebSocket broadcasts.

## Setup

Requirements: Node.js 22+ and pnpm 11+.

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm dev
```

Set different, random values for `VIEW_TOKEN` and `CONTROL_TOKEN` in `.dev.vars`. Set `ALLOWED_ORIGIN` to the exact web-controller origin. Wrangler serves locally at `http://localhost:8787` by default.

Never commit `.dev.vars`. WebSocket query tokens are an MVP compromise for browser compatibility; do not log authenticated URLs, and replace them with short-lived session credentials before exposing a public product.

## Routes

Room IDs must contain 1–64 ASCII letters, numbers, hyphens, or underscores.

- `GET /api/rooms/:room/status` — `Authorization: Bearer <VIEW_TOKEN or CONTROL_TOKEN>`
- `POST /api/rooms/:room/status` — `Authorization: Bearer <CONTROL_TOKEN>`, JSON body `{"status":"busy"}`
- `GET /ws/:room?token=<VIEW_TOKEN or CONTROL_TOKEN>` — WebSocket upgrade

The WebSocket server first sends `{"type":"snapshot","status":"available","updatedAt":...}`. Controllers may send `{"type":"set_status","status":"busy"}`. A changed state is persisted and broadcast to every socket as `{"type":"status_changed","status":"busy","updatedAt":...}`. Repeating the current state keeps its timestamp and returns a snapshot only to that WebSocket sender; duplicate HTTP updates return the unchanged state without broadcasting.

Allowed statuses are exactly `available` and `busy`. Invalid messages receive `{"type":"error","code":"invalid_message"}`; viewer mutations receive `{"type":"error","code":"forbidden"}`.

## Checks and deployment

```sh
pnpm check
pnpm exec wrangler secret put VIEW_TOKEN
pnpm exec wrangler secret put CONTROL_TOKEN
pnpm exec wrangler secret put ALLOWED_ORIGIN
pnpm deploy
```

`pnpm check` runs strict TypeScript checks, the Workers-runtime Vitest integration suite, and a Wrangler production dry-run build. No database or other Cloudflare service is required.
