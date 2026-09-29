# Repository

This private monorepo contains the Telegram gateway, Mini App, workers and shared runtime for Lizard AI. Keep shared modules under `src/`, browser assets under `web/`, and bundled skills under `skills/`. Both services build from the repository root.

# Checks

Use Node 24 or newer. Before pushing code, run `npm run check` and the full test suite with `TEST_DATABASE_URL` pointing to a disposable PostgreSQL database. `sh scripts/test-postgres.sh` creates a local test database; set `PG_BIN` when PostgreSQL is installed elsewhere. Never run tests against production.

# Deployment

The private GitHub repository `lizard-build/lizard-ai`, branch `main`, is the deployment source for the existing `bot` and `worker` services in project `codex-telegram` (`YOUR_PROJECT_ID`). A push to `main` deploys both through the Lizard GitHub integration. CI runs separately and does not hold deployments until checks pass.

- Do not use `lizard up` for these services: it switches them back to uploaded source.
- Keep `bot` on port 3000 with `BOT_ROLE=gateway`, and `worker` on port 0 with `BOT_ROLE=worker`.
- `deploy/lizard.json` records source settings. Use Lizard CLI to apply it only when those settings need to change.
- Keep service IDs, domains, databases and users' Persistent Volumes when changing deployment settings.
- Keep secrets on their existing service scopes. Never commit `.env`, tokens, login state or local reports. Do not print full service responses, environments or logs that may contain credentials.
- The managed-account rollout is gated on platform scope checks. Do not enable it as a side effect of deployment work.
