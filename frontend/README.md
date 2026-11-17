# React frontend

React provides account pages, authenticated course search, and a local demo
watchlist. Search reads `/api/courses`; adding a result to the watchlist does not
persist it or enable backend monitoring. See the [root guide](../README.md) for
Compose setup and [backend guide](../backend/README.md) for the API contract.

## Development

Use Node.js 24 or newer, matching the frontend Docker build. After configuring
the root `.env` as described in the root guide, start the API and Nginx proxy
from the repository root with the Vite browser origin:

```sh
APP_ORIGIN=http://localhost:5173 docker compose up -d --build db backend frontend
cd frontend
npm ci
npm run dev -- --host localhost --port 5173 --strictPort
```

Open `http://localhost:5173`. Vite forwards `/api/` to Nginx at
`http://localhost:8080`, which proxies to Express. The backend's `APP_ORIGIN`
must match the browser origin exactly for registration, login, and logout;
keep the hostname and port consistent. When returning to the normal Compose
UI on port 8080, recreate the backend with the root `.env` origin again:
`docker compose up -d backend` from the repository root.

## Verification and build

From `frontend/`:

```sh
npm run lint
npm run build
```

The build produces `dist/`; the frontend Dockerfile serves it through Nginx.
For deterministic search data and real browser/API checks, follow the
[disposable smoke-test guide](../docs/banner-smoke-test.md).
