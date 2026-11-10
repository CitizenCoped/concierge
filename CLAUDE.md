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
- API base URL: `https://api.agentphone.ai/v1`. The webhook signing secret is
  NOT in the dashboard — it is returned once in the response of
  `POST /v1/agents/{id}/webhook` (agent-level) or `POST /v1/webhooks`
  (project-level). We use an **agent-level** webhook for the concierge agent;
  the account's project-level webhook belongs to a different app
  (fertilitylitigation.vercel.app) and must never be modified.
- **Transfer is cold and agent-level**: the `transferNumber` field lives on the
  agent object. To choose Scott vs Monica per call, `PATCH /v1/agents/{id}`
  with the target number immediately before returning `action: "transfer"`.
  **Owner choice (Nov 2026): transfer immediately** to `SCOTT_PHONE` (or
  Monica when asked for by name) — no 20s silent ack-hold. Still fire
  `guest.denied` / `call.transfer` Pushover + Web Push as the heads-up.
  `SCOTT_PHONE` can later be swapped for a number that rings both phones.
  *(Earlier ack-gated hold from Aug 2026 live testing is retired; `/ack/{id}`
  remains but is no longer linked from notifications.)* The agent webhook
  stays at `timeout: 60` for lookup + PATCH headroom.
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
  in `America/Los_Angeles` and converted at the edge. Active-window filtering
  happens in SQL (`listActiveGuests`); phonetic/fuzzy name matching runs in
  JS against a per-call guest snapshot (`matchGuestAgainst`).
- Webhook handlers verify `X-Webhook-Signature` (HMAC-SHA256 over
  `{timestamp}.{raw_body}`, reject >5 min skew) and dedupe on `X-Webhook-ID`
  before any side effect. Read the **raw body** before JSON parsing.
- Voice webhook responses stream NDJSON; an interim `"One moment."` is sent
  only when a guest lookup is likely — not on every turn.
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

## Deployment record (Aug 2026)

- **Prod URL:** https://angel-concierge.vercel.app (Vercel project
  `angel-concierge`, team `sethrocks-projects`; auto-deploys on push to
  `main`).
- **Front-desk number:** **+1 858 944-0764** (`AGENTPHONE_NUMBER`).
- **Agent:** "Angel Concierge", id `cmsk2931p0xlgg25fubvb1cwp`, webhook voice
  mode, `sttMode: accurate`, agent-level webhook →
  `<prod>/api/agentphone/webhook` (timeout 60s). Provision script sets
  `maxSilenceMs: 60000`; **live agent value not re-verified in this PR** —
  do not assume 60s without reading the provider.
- **Neon:** project `angel-concierge` (`damp-flower-09328590`), same DB for
  dev and prod.

### Deviations from PROMPT.md (all verified by live calls)

1. **Transfer = immediate cold transfer** to `SCOTT_PHONE` (see Architecture).
   The Aug 2026 ack-gated hold was retired after a Nov 2026 live miss: the
   hold left the concierge in silence and nobody's phone rang. Owner chose
   ring-immediately + notify over tap-to-take. Declined transfers can still
   land in personal voicemail (AgentPhone cold-transfer limit).
2. **Per-call state lives in `calls.state` (jsonb)**, not `conversationState`:
   AgentPhone documents no way to set conversationState from webhook responses.
3. **Add-guest default start rounds DOWN to the last 15 min** (PROMPT said
   "next 15 min") — rounding up made just-added guests inactive for up to
   15 minutes and caused a real denial during acceptance testing.
4. **Name handling hardened:** a name auto-extracted from an announcement can
   admit but never deny — on a miss the AI re-asks for the name explicitly;
   denials only follow an explicitly stated name. Partial/single-token replies
   in ASK_NAME re-ask once for first+last before denying. STT fragments
   ("I have a ") get up to two clarification re-asks, then offer a transfer.
   Matching is phonetic+fuzzy (Soundex + Levenshtein) and admits only on
   exactly one active candidate. **Approval and message-taking are not
   terminal** — no app `hangup` on those paths; `activeGuest` is kept for
   Guest Info follow-ups (permissions **and** factual/instruction notes).
   Uncertain notes → offer Scott/Monica (no blind transfer). Negated /
   non-consent resident mentions do not transfer. Human ends the call.
5. **Event catalog additions:** `transfer.request` (legacy ack-hold title;
   no longer emitted on the hot path), `guest.info_answered` ("ℹ️ Guest Info
   Answered"), and `system.test` ("🔔 Test Notification"). Original catalog
   titles unchanged.
6. **TODO:** `PUSHOVER_USER_KEY` is Scott's individual key. For Monica's phone
   to get Pushover notifications, create a delivery group (pushover.net) with
   both user keys and swap it into the env. Web Push already reaches any
   phone with the PWA installed + subscribed.
7. Vercel **preview** env vars were not set (CLI kept demanding a git branch);
   production has everything and only production is used.

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
APP_URL                   prod origin, used for notification deep links
AI_GATEWAY_API_KEY        optional; production Guest Info uses Vercel AI
                          Gateway OIDC (verified live) — no key required on
                          Vercel. Useful for local/non-OIDC runs only.
AI_GATEWAY_MODEL          optional model id (default openai/gpt-4.1-mini)
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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
