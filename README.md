# Angel Concierge

AI front-desk concierge for Scott & Monica's condo building. The building's
front desk calls a dedicated AgentPhone number; an AI answers, checks the
visitor against an approved guest list in Neon Postgres, and either clears
them up, transfers the call to Scott or Monica, or takes a message. A
mobile-first PWA manages the guest list and shows call transcripts, with
Pushover + Web Push notifications at every step.

Built with Next.js (App Router, TypeScript), deployed on Vercel.
See `CLAUDE.md` for architecture and `PROMPT.md` for the build plan.

## Legacy privacy policy

`index.html` at the repo root is the legacy SMS privacy policy served by
GitHub Pages at <https://citizencoped.github.io/concierge/>. It must stay in
place, unmodified, for SMS/10DLC compliance. The app does not serve it.
