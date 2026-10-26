'use strict';
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const MAX_PLAYERS = 4;
const MAX_CONNS = +process.env.MAX_CONNS || 500;
const MAX_LOBBIES = +process.env.MAX_LOBBIES || 200;
const TICK_MS = 66; // ~15 snapshots per second
const CHAT_MAX = 120;      // characters per chat message
const CHAT_GAP_MS = 600;   // min time between one player's messages
const CHAT_HIST = 30;      // messages replayed to someone who joins

const lobbies = new Map(); // code -> { players: Map(id -> player), dirty }

const openLobbies = () => [...lobbies.values()]
  .filter(l => l.pub && l.players.size < MAX_PLAYERS)
  .slice(0, 50)
  .map(l => ({ code: l.code, host: l.host, n: l.players.size }));

const corsFor = (req) => {
  const o = (req.headers.origin || '').replace(/\/$/, '');
  if (!ORIGINS.length) return { 'access-control-allow-origin': '*' };
  return ORIGINS.includes(o) ? { 'access-control-allow-origin': o, vary: 'Origin' } : {};
};

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/lobbies') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...corsFor(req) });
    res.end(JSON.stringify(openLobbies()));
  } else if (path === '/' || path === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end('ok');
  } else { res.writeHead(404); res.end(); }
});

const wss = new WebSocketServer({
  server,
  maxPayload: 1024,
  verifyClient: ({ origin }) => !ORIGINS.length || ORIGINS.includes((origin || '').replace(/\/$/, ''))
});

const num = (v, lo, hi) => { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : lo; };
const clean = (s) => {
  s = s && typeof s === 'object' ? s : {};
  return {
    x: num(s.x, 0, 704), y: num(s.y, 0, 480), d: num(s.d, 0, 3),
    m: s.m ? 1 : 0, md: s.md ? 1 : 0, s: s.s ? 1 : 0,
    g: s.g === 'f' ? 'f' : 'm',
    o: ['jp', 'we', 'sc'].includes(s.o) ? s.o : 'we'
  };
};
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
const cleanName = (v) => String(v == null ? '' : v).replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 12);
const setHost = (lobby) => {
  const first = [...lobby.players.values()].sort((a, b) => a.slot - b.slot)[0];
  lobby.host = first ? first.name : '';
};
const cleanChat = (v) => [...String(v == null ? '' : v)
  .replace(/\s+/g, ' ')
  .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '')
  .trim()].slice(0, CHAT_MAX).join('');
const list = (lobby) => [...lobby.players.values()].map(p => ({ id: p.id, slot: p.slot, n: p.name, s: p.s }));

function removePlayer(ws) {
  const p = ws.player; if (!p) return;
  ws.player = null;
  const lobby = p.lobby;
  lobby.players.delete(p.id);
  if (!lobby.players.size) lobbies.delete(lobby.code); else { setHost(lobby); lobby.dirty = true; }
}

function chat(ws, msg) {
  const p = ws.player, text = cleanChat(msg.m);
  if (!p || !text) return;
  const now = Date.now();
  if (now - p.lastChat < CHAT_GAP_MS) return; // silently drop spam
  p.lastChat = now;
  const lobby = p.lobby, m = { t: 'chat', id: p.id, slot: p.slot, n: p.name, m: text };
  lobby.chat.push(m);
  if (lobby.chat.length > CHAT_HIST) lobby.chat.shift();
  for (const q of lobby.players.values()) send(q.ws, m);
}

function join(ws, msg) {
  if (ws.player) return;
  const code = String(msg.code || '').toLowerCase();
  if (!/^[a-z0-9]{3,8}$/.test(code)) return ws.close(1008, 'bad code');
  let lobby = lobbies.get(code);
  if (lobby && msg.create) { send(ws, { t: 'taken' }); return ws.close(); }
  if (!lobby) {
    if (lobbies.size >= MAX_LOBBIES) { send(ws, { t: 'err', m: 'Server busy' }); return ws.close(); }
    lobby = { code, players: new Map(), dirty: false, pub: msg.pub === true, host: '', chat: [] };
    lobbies.set(code, lobby);
  }
  if (lobby.players.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); return ws.close(); }
  const used = new Set([...lobby.players.values()].map(p => p.slot));
  let slot = 0; while (used.has(slot)) slot++;
  const p = { id: crypto.randomBytes(4).toString('hex'), slot, lobby, name: cleanName(msg.name) || 'Player ' + (slot + 1), s: clean(msg.s), lastChat: 0 };
  ws.player = p; p.ws = ws;
  lobby.players.set(p.id, p); setHost(lobby);
  send(ws, { t: 'joined', id: p.id, code, players: list(lobby), chat: lobby.chat });
  lobby.dirty = true;
}

wss.on('connection', (ws) => {
  if (wss.clients.size > MAX_CONNS) return ws.close(1013, 'busy');
  ws.isAlive = true; ws.msgs = 0; ws.player = null;
  const joinTimer = setTimeout(() => { if (!ws.player) ws.close(); }, 10000);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    ws.msgs++;
    if (ws.msgs > 300) return ws.terminate();
    if (ws.msgs > 60) return; // per-second budget
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'join') join(ws, msg);
    else if (msg.t === 'state' && ws.player) { ws.player.s = clean(msg.s); ws.player.lobby.dirty = true; }
    else if (msg.t === 'name' && ws.player) {
      const nn = cleanName(msg.name);
      if (nn) { ws.player.name = nn; setHost(ws.player.lobby); ws.player.lobby.dirty = true; }
    }
    else if (msg.t === 'chat' && ws.player) chat(ws, msg);
    else if (msg.t === 'leave') { removePlayer(ws); ws.close(); }
  });
  ws.on('close', () => { clearTimeout(joinTimer); removePlayer(ws); });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const lobby of lobbies.values()) {
    if (!lobby.dirty) continue;
    lobby.dirty = false;
    const snap = { t: 'snap', players: list(lobby) };
    for (const p of lobby.players.values()) send(p.ws, snap);
  }
}, TICK_MS);

setInterval(() => { for (const ws of wss.clients) ws.msgs = 0; }, 1000);

// keep proxies from idling out connections and drop dead sockets
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 25000);

server.listen(PORT, () => console.log('Pixel Valley server on :' + PORT));
process.on('SIGTERM', () => { wss.close(); server.close(() => process.exit(0)); });
