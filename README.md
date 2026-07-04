# Second Brain

A private, multi-user interview app that builds a personal "second brain" document across ten life domains, visualized as a constellation. Each user's document is private to their account — it lives in Postgres, not on disk, and is only served to a logged-in session.

## Structure

- `server.js` — Express app: auth (signup/login/logout via email+password, JWT cookie session), per-user state API, and an Anthropic proxy for the interview engine
- `db/init.sql` — `users` and `profiles` (per-user JSONB document state) tables, applied automatically on boot
- `public/second-brain.html` — the frontend (login/signup screen + the constellation app)

## Local development

```
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET, ANTHROPIC_API_KEY
npm start
```

Requires a Postgres database reachable at `DATABASE_URL`.

## Hosting on Zeabur

1. Attach a **Postgres** plugin to the project; Zeabur will provide a `DATABASE_URL` — wire it into this service's environment variables.
2. Set `JWT_SECRET` (any long random string) and `ANTHROPIC_API_KEY` in the service's environment variables.
3. Zeabur detects the Node app via `package.json` and runs `npm start`.

No static hosting / GitHub Pages — this needs a real backend process to keep documents private per-user.
