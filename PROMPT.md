# PROMPT.md — Build Prompt: Angel Concierge

> Run this prompt with Claude Code from `/Users/scottebsen/Projects/AngelAI/concierge`.
> Read `CLAUDE.md` first — it is the project constitution. Work phase by phase;
> **do not start a phase until the previous phase's CHECK block passes.** If a
> check fails, fix it before proceeding. Ask me only when a credential or an
> account-level action is needed that you cannot perform.

---

## Mission

Build, test, and deploy a system that lets an AI answer the condo building's
front-desk calls on behalf of Scott and Monica:

1. Front desk dials a dedicated AgentPhone number when a visitor arrives.
2. The AI greets them, asks for the visitor's name, and checks it against an
   approved guest list stored in Neon Postgres.
3. If the visitor matches an **active** guest entry (name matches AND current
   building-local time is within the entry's start/end window), the AI tells
   the front desk it's okay to send them up.
4. If there is no match — or the front desk is calling about anything else —
   the AI asks the concierge to hold briefly and transfers the call to Scott
   (+16198766618), or to Monica (+18589452875) per the routing rules in §5.
5. If a transfer is not possible / nobody picks up, the AI apologizes and
   takes a message, which is stored and pushed to Scott & Monica.
6. A mobile-first **PWA** lets Scott and Monica manage the guest list and read
   full call transcripts and messages.
7. **Pushover** notifications fire at every interaction point, and the PWA
   mirrors them via Web Push.
8. The code lives in this git repo, is pushed to GitHub, and is deployed to
   Vercel production.

Stack (fixed): Next.js 15+ App Router + TypeScript strict, Vercel,
`@neondatabase/serverless`, raw SQL migrations, `web-push` for VAPID push,
Pushover REST API, AgentPhone in **webhook voice mode**.

---

## Phase 0 — Preflight: credentials & tooling

Verify each item; collect anything missing from me before writing code.

1. Tooling on this machine: `node >= 20`, `npm`, `git`, `gh` (GitHub CLI,
   authenticated — `gh auth status`), `vercel` CLI (or use the Vercel MCP
   tools if available; `npx vercel whoami` to confirm login).
2. Accounts / secrets needed (ask me for any that don't exist yet):
   - **Neon**: a project + pooled `DATABASE_URL`. If I have `neonctl` or the
     Neon MCP connected, create a project named `angel-concierge`; otherwise
     ask me to paste the connection string.
   - **AgentPhone** (agentphone.ai): API key + webhook signing secret from the
     dashboard. Note: accounts start with $5 credit; numbers are $3/mo.
   - **Pushover**: an Application token (create app "Angel Concierge") and a
     **delivery group key** containing both Scott's and Monica's user keys, so
     one API call reaches both phones. If no group exists, use Scott's user
     key and note the TODO.
   - **GitHub**: confirm which account owns the existing `origin` remote
     (`git remote -v`) — this repo already pushes to a GitHub Pages repo
     (`citizencoped/concierge`). We are REUSING this repo. The legacy
     `index.html` privacy policy stays untouched at the repo root so its
     GitHub Pages URL (citizencoped.github.io/concierge) keeps working for
     SMS/10DLC compliance — the app does not need to serve it. Do not change
     GitHub Pages settings.
   - **Vercel**: logged-in account/team to deploy under.
3. Generate VAPID keys locally (`npx web-push generate-vapid-keys`) — do not
   ask me for these.
4. Write all secrets to `.env.local`; ensure `.gitignore` covers `.env*`.

**CHECK 0**
- [ ] `gh auth status` OK; `git remote -v` shows the expected origin.
- [ ] `psql`-less connectivity test: a 5-line Node script using
      `@neondatabase/serverless` runs `select 1` against `DATABASE_URL`.
- [ ] `curl -s https://api.pushover.net/1/messages.json -F token=... -F user=...
      -F message="Angel Concierge preflight ✅"` returns `"status":1` and I
      receive it on my phone.
- [ ] `curl -s https://api.agentphone.ai/v1/agents -H "Authorization: Bearer
      $AGENTPHONE_API_KEY"` returns 200 (empty list is fine). (If the base URL
      differs, discover it from https://docs.agentphone.ai/api-reference and
      record the correct one in CLAUDE.md.)
- [ ] `.env.local` exists and is gitignored (`git check-ignore .env.local`).

---

## Phase 1 — Scaffold

1. Scaffold Next.js (App Router, TS, ESLint, Tailwind, `src/` dir) **into this
   existing repo** without clobbering `.git`, `CLAUDE.md`, `PROMPT.md`,
   `README.md`, or the legacy `index.html` (leave it at repo root, unused by
   the app). Delete the leftover `_to_delete/` folder if present.
2. Update `README.md` to describe the project (keep the privacy-policy link).
3. Commit: `chore: scaffold Next.js app`.

**CHECK 1**
- [ ] `npm run build` succeeds.
- [ ] `index.html` untouched (`git diff --stat HEAD~1 -- index.html` empty).

---

## Phase 2 — Database (Neon)

Migrations in `migrations/*.sql`, applied by `scripts/migrate.ts` (tracks
applied files in a `_migrations` table; idempotent).

```sql
guests (
  id uuid pk default gen_random_uuid(),
  name text not null,
  guest_info text,                -- purpose, unit notes, deliveries, etc.
  guest_phone text,               -- optional
  starts_at timestamptz not null, -- entered in America/Los_Angeles, stored UTC
  ends_at   timestamptz not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  archived boolean not null default false,
  check (ends_at > starts_at)
)

calls (
  id uuid pk,
  agentphone_call_id text unique,       -- callId from webhook
  started_at timestamptz, ended_at timestamptz,
  from_number text,
  outcome text check (outcome in
    ('guest_admitted','no_match_transferred','transfer_attempted',
     'message_taken','hangup','error','in_progress')),
  matched_guest_id uuid references guests(id),
  summary text,
  raw_call_ended jsonb                  -- full agent.call_ended payload
)

call_turns (
  id bigserial pk,
  call_id uuid references calls(id),
  role text check (role in ('caller','agent')),
  text text not null,
  at timestamptz default now()
)

messages (                               -- messages taken for Scott/Monica
  id uuid pk, call_id uuid references calls(id),
  body text not null, taken_at timestamptz default now(),
  read_at timestamptz
)

push_subscriptions (
  id uuid pk, endpoint text unique not null,
  keys jsonb not null, created_at timestamptz default now()
)

webhook_events (                         -- idempotency ledger
  webhook_id text pk, received_at timestamptz default now()
)
```

Guest matching is one SQL query (parameterized):

```sql
select * from guests
where archived = false
  and now() between starts_at and ends_at
  and lower(name) = lower(trim($1));
-- fallback: if 0 rows, retry with first-token match; admit ONLY if exactly 1 row.
```

**CHECK 2**
- [ ] `npm run migrate` applies cleanly twice (second run: "nothing to do").
- [ ] Unit test: seed a guest active now, one expired, one future; matching
      query returns only the active one; first-name fallback admits only when
      unambiguous. `npm test` green.

---

## Phase 3 — Notifications module (Pushover + Web Push)

`src/lib/notify.ts`: single `notify({event, title, message, priority?, url?})`
that (a) POSTs to Pushover, (b) sends Web Push to all `push_subscriptions`
(pruning dead ones on 404/410), (c) never throws into callers (log + Pushover
self-report on failure where possible).

Event catalog (titles are the Pushover titles — keep these exact strings):

| event               | title                          | example message                                   |
|---------------------|--------------------------------|---------------------------------------------------|
| call.started        | 📞 Front Desk Call             | "Front desk is calling the concierge line…"       |
| guest.admitted      | ✅ Guest Admitted              | "Guest = {name} has been let into the building"   |
| guest.denied        | ⛔ No Guest Match              | "'{spoken name}' not on list — transferring"      |
| call.transfer       | 📲 Transferring to {target}    | "Concierge holding; transferring to {target}"     |
| message.taken       | 📝 Message From Concierge      | "Message From Concierge = {body}"                 |
| call.ended          | ☎️ Call Ended                  | "{outcome summary}"                               |
| system.error        | 🚨 Concierge System Error      | "{error}" (priority=1)                            |

**CHECK 3**
- [ ] `npm run smoke -- --notify` sends one Pushover message per event type;
      confirm receipt with me before continuing.
- [ ] Web Push covered in Phase 6 check (needs the PWA installed first).

---

## Phase 4 — AgentPhone webhook endpoint

`src/app/api/agentphone/webhook/route.ts` (Node runtime, NOT edge — needs raw
body + crypto):

1. Read raw body; verify `X-Webhook-Signature` = HMAC-SHA256 of
   `{X-Webhook-Timestamp}.{raw_body}` with `AGENTPHONE_WEBHOOK_SECRET`
   (constant-time compare); reject timestamps older than 5 minutes.
2. Dedupe on `X-Webhook-ID` via `webhook_events` insert-on-conflict-skip.
3. Route by `event`:
   - `agent.message` + `channel:"voice"` → call-flow state machine (§5),
     respond NDJSON (`application/x-ndjson`), first chunk `interim: true`
     within ~1s so the concierge never hears silence.
   - `agent.call_ended` → persist transcript + outcome + `raw_call_ended`,
     fire `call.ended` notify.
   - anything else → 200 + log.
4. Any uncaught error ⇒ respond with a safe spoken fallback ("I'm sorry, I'm
   having trouble — please hold while I transfer you") + trigger transfer path
   + `system.error` notify. **Fail closed: never admit on error.**

**CHECK 4**
- [ ] Signature unit tests: valid sig passes; bad sig / stale timestamp / replayed
      webhook-id are rejected (401 / skipped).
- [ ] Local simulation script `scripts/simulate-call.ts` POSTs a scripted
      conversation (signed) and asserts the NDJSON responses match the
      expected flow for: on-list guest, off-list guest, "package for you"
      general inquiry.

---

## Phase 5 — Call-flow state machine

Implement in `src/lib/callflow.ts` as a pure function
`(state, callerUtterance, dbLookups) → (reply, nextState, effects)` so it is
unit-testable. Persist per-call state keyed by `callId` (DB table or the
`conversationState` echo AgentPhone provides — prefer `conversationState`).

States & behavior:

1. **GREETING** (first `agent.message` of a call): fire `call.started` notify.
   Say: "Hi, Scott and Monica's concierge — how can I help?"
   *(Implementation note: the greeting is spoken by the agent-level
   `beginMessage` at pickup. If the caller's first webhook utterance already
   has content, the state machine answers it directly without re-greeting;
   the spoken fallback greeting only fires on an empty/greeting-only first
   utterance.)*
2. **INTENT**: classify the concierge's utterance:
   - visitor announcement → ASK_NAME (or extract name directly if spoken)
   - anything else (package, maintenance, question for Scott/Monica) →
     TRANSFER
   *(Implementation notes from live testing: STT sometimes delivers dangling
   fragments — e.g. "I have a " — as complete turns; INTENT asks for
   clarification up to twice before failing safe to TRANSFER. A name
   auto-extracted from an announcement is best-effort: on a match it admits,
   but on a miss it re-asks for the name explicitly (ASK_NAME) rather than
   denying — a deny can only follow a name the concierge stated explicitly.)*
3. **ASK_NAME → MATCH**: run the guest matcher (active list loaded once per
   call; phonetic Soundex + Levenshtein, admit only on exactly one candidate).
   - Exactly one active match → say "Yes — {name} is expected. It's okay to
     send them up. Thank you!"; fire `guest.admitted`; mark outcome
     `guest_admitted`; `hangup: true` after confirmation.
   - Partial/single-token miss → re-ask once for first and last name before
     denying.
   - No/ambiguous match after that → say "I don't see them on the approved
     list. Connecting you to Scott or Monica now."; fire `guest.denied`; →
     TRANSFER.
4. **TRANSFER**:
   - Choose target: Scott first (`SCOTT_PHONE`); allow "is Monica available?"
     style requests to select Monica (`MONICA_PHONE`). `SCOTT_PHONE` is the
     easy dial to change later (e.g. a number that rings both phones).
   - `PATCH /v1/agents/{AGENTPHONE_AGENT_ID}` setting `transferNumber` to the
     chosen target, **await success**, then respond with the spoken reply +
     `{"action": "transfer"}` immediately — no ack-hold, no silent wait.
   - Fire `call.transfer` notify (Pushover + Web Push) as the heads-up that
     the front desk is being connected.
   - If the PATCH fails → TAKE_MESSAGE. (AgentPhone cold transfer is one-way;
     a declined transfer can still land in personal voicemail — accepted.)
5. **TAKE_MESSAGE**: "I wasn't able to reach them. I can take a message —
   go ahead." Capture the utterance(s), confirm back, store in `messages`,
   fire `message.taken`, outcome `message_taken`, then thank + hangup.
6. All states: if the concierge says goodbye/nothing further, close politely.
   `maxSilenceMs` on the agent keeps hung calls from running forever.

**CHECK 5**
- [ ] `src/lib/callflow.test.ts` covers: happy-path admit; expired guest
      denied; future guest denied; ambiguous duplicate name → transfer;
      general inquiry → transfer; message taking; DB-error → fail-closed
      transfer. All green.
- [ ] `scripts/simulate-call.ts` full-conversation runs pass for all three
      scenarios end-to-end against `npm run dev`.

---

## Phase 6 — PWA front end

Mobile-first (design at 390px), installable, dark-mode aware.

Pages (all behind passphrase auth except `/privacy` and the webhook):

1. **/** Guest list: active guests up top with time-remaining chips; add-guest
   form with fields exactly: **name**, **start date**, **start time**,
   **end date**, **end time**, **guest info**, **guest phone (optional)**.
   Date/time inputs default: start = now (rounded to next 15 min), end =
   start + 4h. Edit, archive, and "extend 2h" quick action. Times entered and
   displayed in America/Los_Angeles.
2. **/calls** Call log: list with outcome badges; detail view renders the full
   transcript as chat bubbles (concierge vs AI) from `call_turns` /
   `raw_call_ended`, plus outcome, matched guest, and any message taken.
3. **/messages** Messages inbox with read/unread.
4. **/settings** Enable notifications button (Web Push subscribe → store in
   `push_subscriptions`), test-notification button, logout.

PWA plumbing: `manifest.webmanifest` (name "Angel Concierge", standalone,
icons — generate a simple bell/door icon), service worker handling `push` and
`notificationclick` (deep-link to /calls/{id} or /messages), Web Push via
VAPID keys from Phase 0.

Auth: middleware checks an httpOnly signed cookie; `/login` posts the
passphrase, compares to `APP_PASSPHRASE` (constant-time), sets 180-day cookie.

**CHECK 6**
- [ ] Lighthouse PWA installability passes locally (`npx lighthouse` or manual
      audit): manifest valid, SW registered, served over HTTPS in prod.
- [ ] Add/edit/archive guest round-trips to Neon; times display correctly in
      America/Los_Angeles (test a guest spanning midnight and a DST boundary).
- [ ] With the PWA installed and subscribed, `npm run smoke -- --notify` shows
      BOTH a Pushover and a Web Push notification.
- [ ] Wrong passphrase → 401; webhook route reachable WITHOUT auth cookie.

---

## Phase 7 — Git & GitHub

1. Ensure clean tree; commits at each phase boundary were made along the way.
2. Reuse the existing `origin` (citizencoped/concierge). Leave GitHub Pages
   settings and `index.html` alone — the Pages-hosted privacy policy URL must
   stay live for SMS/10DLC compliance.
3. Push `main`.

**CHECK 7**
- [ ] `git status` clean; `gh repo view --web`-able; latest commit visible on
      GitHub; no `.env*` or secrets in `git log -p` (run
      `git log -p | grep -iE 'api[_-]?key|secret|token' ` sanity pass).

---

## Phase 8 — Deploy to Vercel + provision AgentPhone

1. `vercel link` (or Vercel MCP) → project `angel-concierge`; set ALL env vars
   from CLAUDE.md's table for Production (and Preview); `vercel deploy --prod`.
   Connect the GitHub repo for auto-deploys on push to `main`.
2. Run `npm run migrate` against production `DATABASE_URL` (same Neon DB).
3. **Provision AgentPhone** via `scripts/provision-agentphone.ts` (idempotent):
   - Create agent "Angel Concierge" — webhook voice mode, webhook URL
     `https://<prod-domain>/api/agentphone/webhook`, `beginMessage` greeting
     from §5, `transferNumber` = `SCOTT_PHONE`, sensible voice, `sttMode:
     "accurate"`, `maxSilenceMs` ≈ 60000.
   - Provision a phone number (ask me for preferred area code, e.g. 619) and
     attach it to the agent. Record as `AGENTPHONE_NUMBER` in Vercel env +
     CLAUDE.md + tell me the number prominently.
4. **Live transfer-behavior test** (resolves the §4 ⚠️): I call the number,
   ask for a fake guest, and let it transfer while Scott declines the call.
   Observe: does the platform return control / end the call / go to Scott's
   voicemail? Implement the decided fallback from §5 accordingly and redeploy.

**CHECK 8 — full end-to-end acceptance (do these WITH me on the phone)**
- [ ] `curl https://citizencoped.github.io/concierge/` still serves the legacy
      privacy policy (untouched by the push).
- [ ] Add guest "Test Visitor" (active now) in the PWA from a phone.
- [ ] Call the AgentPhone number, announce "Test Visitor": AI admits; Pushover
      "✅ Guest Admitted — Guest = Test Visitor has been let into the
      building" arrives; Web Push arrives; call appears in /calls with full
      transcript.
- [ ] Call again with an unknown name: AI holds + transfers; "📞 Front Desk
      Call" and "📲 Transferring" notifications arrive; Scott's phone rings.
- [ ] Call, decline the transfer: message-taking path works; "📝 Message From
      Concierge = …" arrives; message shows in /messages.
- [ ] `agent.call_ended` transcripts stored for all three calls
      (`select count(*) from calls` ≥ 3, outcomes correct).
- [ ] Webhook signature check live: a forged unsigned POST to the prod webhook
      returns 401 and creates no records.
- [ ] Redeploy from a trivial commit to `main` auto-builds on Vercel.

---

## Phase 9 — Wrap up

1. Update CLAUDE.md with: final prod URL, AgentPhone number, agent ID, any
   deviations from this prompt (especially the transfer-fallback decision).
2. Update README.md with a 5-line "how it works" + the PWA install steps for
   Monica's phone.
3. Final commit + push; confirm Vercel deployed; send me the prod URL, the
   AgentPhone number to give the front desk, and the passphrase reminder.

**Definition of done:** every CHECK box above is ticked, the front desk number
is live, and both Scott's and Monica's phones received real notifications from
a real phone call.
