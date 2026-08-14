# CLAUDE.md — Angel Concierge

AI front-desk concierge for Scott & Monica's condo building. When the building's
front desk has a visitor for the unit, they call a dedicated AgentPhone number
instead of Scott's cell. The AI answers, checks the visitor against an approved
guest list, and either clears them up, transfers the call to Scott/Monica, or
takes a message. A mobile-first PWA manages the guest list and shows call
transcripts, with Pushover + Web Push notifications at every step.

## People & numbers (canonical — do not invent others)

| Role    | Name   | Phone (E.164)  |
|---------|--------|----------------|
| Owner   | Scott  | +16198766618   |
| Partner | Monica | +18589452875   |

The AgentPhone number dedicated to the front desk is provisioned during setup
and stored in env as `AGENTPHONE_NUMBER` — never hardcode it.

## Architecture

```
Front desk phone ──▶ AgentPhone number ──▶ AgentPhone voice engine
                                                │  (webhook mode)
                                POST /api/agentphone/webhook  (Next.js, Vercel)
                                                │
                    ┌───────────────┬───────────┴────────────┐
                Neon Postgres   Pushover REST            Web Push (VAPID)
              (guests, calls,  (Scott + Monica           (PWA notifications)
               transcripts,     delivery group)
               messages)
                                                │
                     PWA (Next.js App Router UI, mobile-first)
                     guest CRUD · live call log · transcripts · messages
```

- **AgentPhone** (docs.agentphone.ai) runs in **webhook mode**: every caller
  utterance arrives as `agent.message` (`channel: "voice"`); we reply with
  `{"text": ...}` (NDJSON streaming preferred), `{"action": "transfer"}`, or
  `{"hangup": true}`. Full transcript arrives on `agent.call_ended`.
- **Transfer is cold and agent-level**: the `transferNumber` field lives on the
  agent object. To choose Scott vs Monica per call, `PATCH /v1/agents/{id}`
  with the target number immediately before returning `action: "transfer"`.
  There is **no documented no-answer callback** after a cold transfer — see
  "Transfer fallback" in PROMPT.md; do not silently assume the call returns.
- **Neon** is the single source of truth: guest list, call records, transcript
  turns, messages taken, push subscriptions.
- **Pushover** is fired server-side at every interaction point (call started,
  guest admitted, guest denied, transfer attempted, message taken, errors).
- **PWA**: installable manifest + service worker + Web Push (VAPID) mirroring
  the Pushover events.

## Stack & conventions

- Next.js 15+, App Router, TypeScript strict. Deployed on **Vercel**.
- DB access via `@neondatabase/serverless` (HTTP driver — Vercel-friendly).
  Plain SQL in `src/lib/db/` with a tiny query helper; migrations are numbered
  `.sql` files in `migrations/` applied by `scripts/migrate.ts`. No ORM.
- All times stored **UTC** in Postgres (`timestamptz`); guest windows entered
  in `America/Los_Angeles` and converted at the edge. Guest-window matching
  happens in SQL, never in JS.
- Webhook handlers verify `X-Webhook-Signature` (HMAC-SHA256 over
  `{timestamp}.{raw_body}`, reject >5 min skew) and dedupe on `X-Webhook-ID`
  before any side effect. Read the **raw body** before JSON parsing.
- Voice webhook responses stream NDJSON with an `interim` chunk first so the
  concierge never hears dead air.
- Notifications go through one module, `src/lib/notify.ts` — every event calls
  `notify(event)` which fans out to Pushover + Web Push + DB log. Never call
  Pushover directly from route handlers.
- App auth: shared passphrase (`APP_PASSPHRASE`) checked by middleware,
  long-lived httpOnly cookie. Everything requires it except the AgentPhone
  webhook route.
- Mobile-first UI; test at 390px width. Dark-mode friendly.

## Repo layout

```
CLAUDE.md            this file
PROMPT.md            the full build prompt (source of truth for requirements)
index.html           legacy SMS privacy policy, served by GitHub Pages at
                     citizencoped.github.io/concierge — LEAVE IN PLACE at repo
                     root so that live URL keeps working; the app itself does
                     not serve or link it.
migrations/          numbered SQL migrations
scripts/             migrate.ts, provision-agentphone.ts, smoke-test.ts
src/app/             App Router pages + api routes
src/lib/             db, agentphone, pushover, webpush, notify, auth
```

This repo previously held only that GitHub-Pages privacy policy. The phone
number on it (619-876-6617) belongs to a different SMS service — never edit
or delete the file; GitHub Pages settings stay as they are.

## Environment variables (all required unless noted)

```
DATABASE_URL              Neon pooled connection string
AGENTPHONE_API_KEY        AgentPhone API key
AGENTPHONE_WEBHOOK_SECRET webhook signing secret
AGENTPHONE_AGENT_ID       created during provisioning
AGENTPHONE_NUMBER         the dedicated front-desk number (E.164)
PUSHOVER_APP_TOKEN        Pushover application token
PUSHOVER_USER_KEY         Pushover user or delivery-group key (Scott+Monica)
VAPID_PUBLIC_KEY          Web Push
VAPID_PRIVATE_KEY         Web Push (secret)
VAPID_SUBJECT             mailto:serasomatic@gmail.com
APP_PASSPHRASE            shared login secret for the PWA
SCOTT_PHONE               +16198766618
MONICA_PHONE              +18589452875
TZ_HOME                   America/Los_Angeles (optional, default this)
```

Secrets live in `.env.local` (gitignored) and Vercel project env. **Never
commit secrets; never print them in logs or transcripts.**

## Commands

```
npm run dev            local dev
npm run build          production build (must pass before any deploy)
npm run migrate        apply pending SQL migrations to Neon
npm run smoke          scripts/smoke-test.ts — checks DB, Pushover,
                       AgentPhone API auth, webhook signature round-trip
npm run provision      scripts/provision-agentphone.ts — idempotent agent +
                       number setup against the AgentPhone API
```

## Guardrails

- The guest list controls physical building access. Fail **closed**: any
  matching ambiguity, DB error, or webhook parse failure ⇒ do NOT admit;
  transfer/hold instead, and notify.
- Guest name matching: case-insensitive, trimmed, tolerant of "first-name
  only if unique in the active window" — but exact-window validity is strict
  (`start ≤ now ≤ end` in building-local time).
- Idempotency everywhere webhooks touch money/access/notifications.
- Any change to the call-flow state machine requires updating both the flow
  doc in PROMPT.md §5 and the tests in `src/lib/callflow.test.ts`.
- Deploy path: commit → push to GitHub `main` → Vercel production. Never
  deploy uncommitted work.
