# ikcneszzs.xyz

Fullstack blog for Chinese business leaders entering Western markets: cultural intelligence, international trade, trust building, and long-term B2B growth.

## Stack

- Frontend: Vite, React, TypeScript, SCSS, client-side routing, admin panel included.
- Backend: Node.js, Express, TypeScript, PostgreSQL in development, SQLite in production, Redis.
- Security: bcrypt password hash, JWT access tokens, revocable refresh tokens in httpOnly cookies, CSRF token checks for refresh/logout/admin mutations, CORS from env, rate limiting, sanitizer, audit log.
- AI: OpenRouter integration with default model `meta-llama/llama-3.1-8b-instruct`.
- Docker: production has a one-time PostgreSQL and uploads migration service; development keeps PostgreSQL and admin seed services.

## Dev Start

```bash
npm run dev:docker
```

This creates `.env`, `backend/.env`, `frontend/.env`, builds containers, starts PostgreSQL, Redis, backend on `4000`, and frontend on `3000`.

You can also run:

```bash
docker compose up --build -d
```

## Local URLs

- Frontend: `http://localhost:3000`
- Backend health: `http://localhost:4000/api/health`
- Admin: `http://localhost:3000/admin`

## Superadmin

The development `admin-seed` Docker service creates or updates the superadmin in PostgreSQL using `LOCAL_SUPERADMIN_EMAIL` and `LOCAL_SUPERADMIN_PASSWORD`. Existing production accounts are transferred to SQLite.

Dev defaults:

```txt
admin@ikcneszzs.local
MySecretPassword123!
```

Change them in root `.env`, then rerun:

```bash
docker compose up admin-seed
```

The password is stored as a bcrypt hash, never plain text.

## Environment Setup

Real env files are ignored by git. Example files are committed:

- `.env.example`
- `.env.production.example`
- `backend/.env.example`
- `backend/.env.production.example`
- `frontend/.env.example`
- `frontend/.env.production.example`

JWT secrets are generated automatically by setup scripts.

## OpenRouter Key

Add your key once to root `.env`:

```txt
OPENROUTER_API_KEY=your_key_here
```

Then run:

```bash
npm run setup:dev-env
```

The script copies the key into `backend/.env`. Without a key, production returns a clear error. Dev mode returns a draft placeholder so the admin flow can be tested safely.

Do not run real AI generation unless you intentionally click `Generate now` or enable scheduled generation.

## Master Prompt

The default master prompt is stored in `admin_settings` (PostgreSQL in development, SQLite in production). The backend always reads `settings.masterPrompt` before calling OpenRouter.

To change it, open `http://localhost:3000/admin`, login as superadmin, edit `AI generation settings`, and save.

## Articles

Admin supports article list, create/edit/delete, draft/published status, local cover image selector, AI generation settings, and manual `Generate now`.

Generated articles are saved in PostgreSQL in development and SQLite in production. Cover images are selected from local assets under `frontend/public/covers` or uploaded to `./media/covers` in production. Their URLs remain `/uploads/covers/...`.

## JWT / Refresh Flow

- Login returns a short-lived access token and a CSRF token.
- Refresh token is stored as an httpOnly cookie.
- The refresh token database record stores only a hash plus CSRF token.
- Refresh and logout require `x-csrf-token`.
- Admin create/update/delete/settings/generation actions require both Bearer JWT and `x-csrf-token`.
- Logout revokes the refresh token and clears the cookie.

## Production PostgreSQL → SQLite cutover (Linux)

**Back up first, before replacing code.** Run these commands from the existing production project directory. Use the same Compose project name as the old deployment (`docker compose -f docker-compose.prod.yml config --format json` shows it). Do not rename the project directory or change `COMPOSE_PROJECT_NAME` during the cutover; Compose volume names depend on that name.

```bash
mkdir -p backups
project=$(docker compose -f docker-compose.prod.yml config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
docker volume inspect "${project}_postgres-data" "${project}_uploads-data" >/dev/null
docker compose -f docker-compose.prod.yml stop backend postgres
docker run --rm -v "${project}_postgres-data:/source:ro" -v "$PWD/backups:/backup" alpine tar -C /source -czf /backup/postgres-volume-before-sqlite.tar.gz .
docker run --rm -v "${project}_uploads-data:/source:ro" -v "$PWD/backups:/backup" alpine tar -C /source -czf /backup/uploads-volume-before-sqlite.tar.gz .
mkdir -p backups/backend backups/frontend
cp -a .env.production backups/
cp -a backend/.env.production backups/backend/
test ! -f frontend/.env.production || cp -a frontend/.env.production backups/frontend/
if ls db.sqlite3* >/dev/null 2>&1; then cp -a db.sqlite3* backups/; fi
test ! -d media || cp -a media backups/media.before-cutover
```

Keep these backups outside the project before a future cleanup. Then update the code **in that same directory**. Keep the existing ignored `.env.production`, `backend/.env.production`, and `frontend/.env.production`; the new Compose reads them directly. Check `CORS_ORIGIN` and `REDIS_URL` in the backend file and `VITE_API_URL` in the frontend file before the launch. If this is a fresh installation, run `npm run setup:prod-env`, review the generated values, and initialize the PostgreSQL application schema before cutover. An absent or wrong PostgreSQL volume makes migration fail closed.

The working launch after updating code is one command:

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

`migrate` reads the existing `postgres-data` and `uploads-data` volumes. It stops any still-running old backend in the same Compose project before copying, then checks source tables and columns, per-table row counts, SQLite integrity and foreign keys, media hashes, and uploaded cover URLs. It writes a temporary file in the project root and publishes `./db.sqlite3` only after all checks pass. The backend depends on its successful exit and uses the host files `./db.sqlite3` and `./media`; SQLite uses DELETE journaling, so the project directory must stay writable for journal creation. Docker normally creates these files as root; use `sudo` for host maintenance when needed. The source volumes remain intact and are never removed by this Compose file.

The migration service temporarily mounts `/var/run/docker.sock` to identify and stop only the old backend container carrying the same Compose project label. Protect access to this Compose file and the Docker socket as you would other server administration access.

On later `up` runs, a valid `db.sqlite3` is retained, including records written since the cutover. If migration fails, inspect `docker compose -f docker-compose.prod.yml logs migrate`; fix the reported issue and repeat the same launch command. Do not delete a valid SQLite file to force reimport after the application has accepted writes.

Verify on the server:

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs migrate backend
test -f ./db.sqlite3 && test -d ./media
curl -fsS http://localhost:4102/api/health
```

For a stored cover URL such as `/uploads/covers/example.png`, check `curl -fI http://localhost:8097/uploads/covers/example.png`. The same path is served by the backend on port 4102. The static `/covers/...` assets remain in the frontend image.

## Rebuild

```bash
npm run docker:rebuild
```

or:

```bash
docker compose down
docker compose up --build -d
```

## Troubleshooting

- Port `3000` busy: stop the process using it or change `frontend/vite.config.ts` and compose port mapping.
- Port `4000` busy: stop the process or change backend `PORT` and compose mapping.
- Database not ready: check `docker compose -f docker-compose.prod.yml logs postgres migrate backend`; do not start the backend against an empty SQLite file.
- Development admin login fails: inspect `docker compose logs admin-seed`, then rerun `docker compose up admin-seed`.
- AI generation fails: verify `OPENROUTER_API_KEY` exists in `backend/.env` and do not expose it in logs or frontend env.
- CORS error: check `CORS_ORIGIN` in `backend/.env`.
