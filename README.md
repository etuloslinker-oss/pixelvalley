# Pixel Valley Online

- `server/` Node WebSocket lobby server (deploy to Render)
- `web/` static game (deploy to Vercel)

## 1. Deploy the server on Render
1. Push this folder to a GitHub repo.
2. Render: New > Blueprint (uses `render.yaml`), or New > Web Service with Root Directory `server`, Build `npm install`, Start `npm start`, Health Check Path `/health`.
3. Copy the service URL, e.g. `https://pixel-valley-server.onrender.com`.

## 2. Point the game at it
Edit `web/config.js`:
    window.PV_SERVER = 'wss://pixel-valley-server.onrender.com';

## 3. Deploy the game on Vercel
New Project > import the repo, set Root Directory to `web`, Framework Preset "Other", no build command.

## 4. Lock the server to your site (recommended)
In Render, set `ALLOWED_ORIGINS` to your Vercel URL (comma-separate several), e.g. `https://pixel-valley.vercel.app`.

## Notes
- Free Render services sleep when idle; the first player may wait up to a minute (the game retries and shows progress).
- Lobbies live in server memory; they vanish when empty or when the server restarts.
- Max 4 players per lobby is enforced by the server. Optional env vars: `MAX_CONNS` (500), `MAX_LOBBIES` (200).
- Run locally: `cd server && npm install && npm start`, then set `PV_SERVER = 'ws://localhost:8080'` and open `web/index.html`.
