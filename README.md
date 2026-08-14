# Angel Concierge

AI front-desk concierge for Scott & Monica's condo building, live at
**https://angel-concierge.vercel.app** answering **+1 858 944-0764**.

## How it works

1. The front desk calls the dedicated number; an AI answers and asks who's
   visiting.
2. The visitor's name is checked against the approved guest list (Neon
   Postgres, strict time windows in building-local time).
3. On a match the AI clears them up; otherwise it holds the caller and sends
   Scott & Monica a priority "tap to take the call" notification.
4. If someone taps within ~20 seconds the call transfers to their phone;
   otherwise the AI takes a message.
5. Every step fires Pushover + Web Push notifications, and the PWA shows the
   guest list, full call transcripts, and messages.

Built with Next.js (App Router, TypeScript) on Vercel + AgentPhone webhook
voice mode. See `CLAUDE.md` for architecture and the deployment record;
`PROMPT.md` is the original build plan.

## Installing the app on a phone (for Monica)

1. Open **https://angel-concierge.vercel.app** in Safari (iPhone) or Chrome
   (Android) and log in with the shared passphrase.
2. iPhone: tap **Share → Add to Home Screen**. Android: tap **⋮ → Add to
   Home screen / Install app**.
3. Open **Angel Concierge from the Home Screen**, go to **Settings →
   Enable notifications**, and allow notifications when prompted.
4. Tap **Send test notification** to confirm it works.

## Legacy privacy policy

`index.html` at the repo root is the legacy SMS privacy policy served by
GitHub Pages at <https://citizencoped.github.io/concierge/>. It must stay in
place, unmodified, for SMS/10DLC compliance. The app does not serve it.
