'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { resolveGoogleMapsInput } = require('./maps');

const PORT = process.env.PORT || 3000;
const SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT || process.env.GOOGLE_SHEETS_SERVICE_ACCOUNT || '';
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
// Preferred storage: Supabase (SUPABASE_URL + server-only SUPABASE_SERVICE_KEY).
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
// Backup kept on the repo's `data` branch by the GitHub Actions workflow; restored on boot
// when the local data.json is gone (Render's free disk is wiped on every restart).
const BACKUP_URLS = (process.env.BACKUP_URL || [
  'https://raw.githubusercontent.com/Lee200202/restaurant-vote-server/data/state.json',
  'https://api.github.com/repos/Lee200202/restaurant-vote-server/contents/state.json?ref=data'
].join(' ')).split(/\s+/).filter(Boolean);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
// Voter IDs are never stored in plain form: only a salted SHA-256 hash.
const VOTER_SALT = process.env.VOTER_SALT || 'restaurant-vote-default-salt';

const DEFAULT_STATE = {
  title: '這週末聚餐去哪吃？',
  description: '貼上或拖曳 Google Maps 連結，點擊卡片可直接開啟地圖，右側匿名投票',
  voteMode: 'multi',
  sortBy: 'votes'
};

function hashVoter(voterId) {
  return crypto.createHash('sha256').update(VOTER_SALT + ':' + voterId).digest('hex');
}

function cleanVoterId(raw) {
  const v = String(raw || '').trim();
  return v && v.length <= 100 ? v : '';
}

// Public view of a restaurant. `voters` only ever contains the requesting
// browser's own anonymous ID (when it has voted) — nobody can see who voted for what.
function publicItem(r, voterId, voterHashes) {
  const mine = !!voterId && voterHashes.includes(hashVoter(voterId));
  return {
    id: r.id, name: r.name, address: r.address || '', url: r.url,
    votes: voterHashes.length, voters: mine ? [voterId] : [], createdAt: Number(r.createdAt)
  };
}

// ---------------- Storage ----------------
// All data lives in memory for fast reads and is persisted to a backend:
// Google Sheets (when GOOGLE_SERVICE_ACCOUNT + GOOGLE_SHEET_ID are set) or a local data.json file.
// Each restaurant: { id, name, address, url, createdAt, ballots: [{ h: voterHash, t: timestamp }] }

function emptyData() {
  return { ...DEFAULT_STATE, restaurants: [] };
}

// Accept both our format and the original server's data.json format (plain voter IDs → hashed).
function normalizeData(parsed) {
  const data = { ...DEFAULT_STATE, ...(parsed || {}) };
  data.restaurants = (Array.isArray(data.restaurants) ? data.restaurants : []).map(r => ({
    id: String(r.id), name: String(r.name || ''), address: String(r.address || ''), url: String(r.url || ''),
    createdAt: Number(r.createdAt) || Date.now(),
    ballots: Array.isArray(r.ballots) ? r.ballots : (Array.isArray(r.voters) ? r.voters.map(v => ({ h: hashVoter(v), t: 0 })) : [])
  }));
  return data;
}

function createFilePersistence(file) {
  return {
    kind: 'file',
    async load() {
      if (!fs.existsSync(file)) return null;
      return normalizeData(JSON.parse(fs.readFileSync(file, 'utf8')));
    },
    async save(data) {
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    }
  };
}

// Supabase Postgres: the whole poll lives in one jsonb row (table public.poll_state, see schema.sql).
// Uses the server-only secret key over Supabase's REST API; RLS blocks every other client.
function createSupabasePersistence(baseUrl, key) {
  const endpoint = baseUrl.replace(/\/+$/, '') + '/rest/v1/poll_state';
  async function call(url, opts) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(url, {
          ...opts,
          signal: AbortSignal.timeout(10000),
          headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(opts && opts.headers) }
        });
        if (res.ok) return res;
        const text = (await res.text()).slice(0, 200);
        lastErr = new Error('Supabase HTTP ' + res.status + ': ' + text);
        if (res.status < 500 && res.status !== 429) throw Object.assign(lastErr, { fatal: true });
      } catch (err) {
        if (err.fatal) throw err;
        lastErr = err;
      }
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
    throw lastErr;
  }
  return {
    kind: 'supabase',
    async load() {
      const rows = await (await call(endpoint + '?id=eq.1&select=data')).json();
      if (!rows.length || !rows[0].data) return null; // brand-new table
      return normalizeData(rows[0].data);
    },
    async save(data) {
      await call(endpoint, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ id: 1, data, updated_at: new Date().toISOString() })
      });
    }
  };
}

const TAB_POLL = '投票設定';
const TAB_RESTAURANTS = '候選餐廳';
const TAB_VOTES = '投票紀錄';
const range = (tab, cols) => "'" + tab + "'!" + cols;

function createSheetsPersistence(serviceAccount, sheetId) {
  const { createSheetsClient } = require('./sheets');
  const client = createSheetsClient(serviceAccount);
  const lastRows = { [TAB_POLL]: 0, [TAB_RESTAURANTS]: 0, [TAB_VOTES]: 0 };
  const fmt = ms => (ms ? new Date(Number(ms)).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '');

  return {
    kind: 'google-sheets',
    clientEmail: client.clientEmail,
    async init() {
      const meta = await client.meta(sheetId);
      const have = new Set((meta.sheets || []).map(sh => sh.properties.title));
      const add = [TAB_POLL, TAB_RESTAURANTS, TAB_VOTES].filter(t => !have.has(t)).map(title => ({ addSheet: { properties: { title } } }));
      if (add.length) await client.batchUpdate(sheetId, add);
    },
    async load() {
      const res = await client.batchGet(sheetId, [range(TAB_POLL, 'A:B'), range(TAB_RESTAURANTS, 'A:E'), range(TAB_VOTES, 'A:C')]);
      const [pollRows, restRows, voteRows] = (res.valueRanges || []).map(v => v.values || []);
      lastRows[TAB_POLL] = pollRows.length; lastRows[TAB_RESTAURANTS] = restRows.length; lastRows[TAB_VOTES] = voteRows.length;
      if (!pollRows.length && !restRows.length) return null; // brand-new sheet
      const data = emptyData();
      for (const [k, v] of pollRows.slice(1)) {
        if (k === 'title' && String(v || '').trim()) data.title = String(v);
        if (k === 'description') data.description = String(v == null ? '' : v);
        if (k === 'voteMode' && (v === 'multi' || v === 'single')) data.voteMode = v;
        if (k === 'sortBy' && (v === 'votes' || v === 'newest')) data.sortBy = v;
      }
      const byId = new Map();
      for (const row of restRows.slice(1)) {
        const [id, name, address, url, createdAt] = row;
        if (!id || !url) continue;
        const r = { id: String(id), name: String(name || '未命名餐廳'), address: String(address == null ? '' : address), url: String(url), createdAt: Number(createdAt) || Date.now(), ballots: [] };
        byId.set(r.id, r);
        data.restaurants.push(r);
      }
      for (const [rid, h, t] of voteRows.slice(1)) {
        const r = byId.get(String(rid));
        if (r && h && !r.ballots.some(b => b.h === h)) r.ballots.push({ h: String(h), t: Number(t) || 0 });
      }
      return data;
    },
    async save(data) {
      const pad = (tab, rows, width) => {
        const out = rows.slice();
        while (out.length < lastRows[tab]) out.push(new Array(width).fill(''));
        lastRows[tab] = rows.length;
        return out;
      };
      const pollRows = [
        ['設定', '值'],
        ['title', data.title], ['description', data.description], ['voteMode', data.voteMode], ['sortBy', data.sortBy]
      ];
      const restRows = [['id', '餐廳名稱', '地址', 'Google Maps 連結', '建立時間戳(ms)', '票數', '建立時間']]
        .concat(data.restaurants.map(r => [r.id, r.name, r.address, r.url, r.createdAt, r.ballots.length, fmt(r.createdAt)]));
      const voteRows = [['餐廳 id', '匿名投票者（雜湊）', '時間戳(ms)', '餐廳名稱', '投票時間']];
      for (const r of data.restaurants) for (const b of r.ballots) voteRows.push([r.id, b.h, b.t, r.name, fmt(b.t)]);
      await client.batchWrite(sheetId, [
        { range: range(TAB_POLL, 'A1'), values: pad(TAB_POLL, pollRows, 2) },
        { range: range(TAB_RESTAURANTS, 'A1'), values: pad(TAB_RESTAURANTS, restRows, 7) },
        { range: range(TAB_VOTES, 'A1'), values: pad(TAB_VOTES, voteRows, 5) }
      ]);
    }
  };
}

function createStore(persistence) {
  let data = emptyData();
  let version = 0;        // bumps on every change
  let savedVersion = 0;   // last version persisted
  let saving = null;
  let timer = null;

  async function flush() {
    if (saving) return saving;
    if (savedVersion === version) return;
    const target = version;
    const snapshot = JSON.parse(JSON.stringify(data));
    saving = persistence.save(snapshot)
      .then(() => { savedVersion = Math.max(savedVersion, target); })
      .catch(err => { console.error('Save failed (will retry):', err.message); scheduleSave(5000); })
      .finally(() => { saving = null; if (savedVersion < version) scheduleSave(); });
    return saving;
  }

  function scheduleSave(delay) {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, delay == null ? 800 : delay);
  }

  // `trusted`: the in-memory data is the real current state (loaded, restored, or changed
  // since boot). The backup job only overwrites the GitHub backup when this is true, so a
  // failed restore can never replace a good backup with an empty list.
  let trusted = false;
  let lastRestoreTry = 0;
  let restoring = null;

  async function fetchBackup() {
    let missing = 0;
    for (const url of BACKUP_URLS) {
      try {
        const res = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), {
          headers: { Accept: 'application/vnd.github.raw', 'User-Agent': 'restaurant-vote-server' },
          signal: AbortSignal.timeout(8000)
        });
        if (res.status === 404) { missing++; continue; }
        if (!res.ok) continue;
        const json = await res.json();
        const payload = json && json.data ? json.data : json;
        if (payload && Array.isArray(payload.restaurants)) return { data: normalizeData(payload) };
      } catch (e) { /* try the next URL */ }
    }
    return { missing: missing === BACKUP_URLS.length };
  }

  async function restoreFromBackup() {
    lastRestoreTry = Date.now();
    const r = await fetchBackup();
    if (trusted) return; // a change happened meanwhile; keep it
    if (r.data) {
      data = r.data; trusted = true; version++; scheduleSave();
      console.log('Restored ' + data.restaurants.length + ' restaurants from GitHub backup');
    } else if (r.missing) {
      trusted = true; // no backup exists yet: an empty start is genuine
    } else {
      console.error('Backup restore failed; will retry');
    }
  }

  const changed = () => { version++; trusted = true; scheduleSave(); };
  const find = id => data.restaurants.find(r => r.id === id);

  return {
    kind: persistence.kind,
    persistence,
    async init() {
      if (persistence.init) await persistence.init();
      const loaded = await persistence.load();
      if (loaded) { data = loaded; trusted = true; savedVersion = version; return; }
      if (persistence.kind === 'file' && BACKUP_URLS.length) { await restoreFromBackup(); return; }
      version++; await flush(); // write defaults to a brand-new backend
      savedVersion = version; trusted = true;
    },
    // Called before every request: if the boot-time restore failed, try again (throttled)
    // so a change never lands on top of an incomplete state.
    async ensureRestored(force) {
      if (trusted) return;
      if (restoring) return restoring;
      if (!force && Date.now() - lastRestoreTry < 15000) return;
      restoring = restoreFromBackup().finally(() => { restoring = null; });
      return restoring;
    },
    backup: () => ({ trusted, savedAt: Date.now(), data }),
    // Pick up edits made directly in the spreadsheet, only when nothing is pending.
    async reload() {
      if (saving || timer || savedVersion !== version) return;
      const v = version;
      const loaded = await persistence.load();
      if (loaded && v === version && !saving && !timer) data = loaded;
    },
    flush: async () => { if (timer) { clearTimeout(timer); timer = null; } await flush(); if (saving) await saving; },
    async getState(voterId) {
      const vh = voterId ? hashVoter(voterId) : '';
      return {
        title: data.title, description: data.description, voteMode: data.voteMode, sortBy: data.sortBy,
        restaurants: data.restaurants.map(r => {
          const mine = !!vh && r.ballots.some(b => b.h === vh);
          return { id: r.id, name: r.name, address: r.address, url: r.url, votes: r.ballots.length, voters: mine ? [voterId] : [], createdAt: r.createdAt };
        })
      };
    },
    async updatePoll(f) { Object.assign(data, f); changed(); },
    async addRestaurant(r) { data.restaurants.unshift({ ...r, ballots: [] }); changed(); },
    async clearRestaurants() { data.restaurants = []; changed(); },
    async updateRestaurant(id, f) { const r = find(id); if (!r) return false; Object.assign(r, f); changed(); return true; },
    async deleteRestaurant(id) {
      const n = data.restaurants.length;
      data.restaurants = data.restaurants.filter(r => r.id !== id);
      if (data.restaurants.length === n) return false;
      changed(); return true;
    },
    async toggleVote(id, voterId) {
      const target = find(id);
      if (!target) return null;
      const vh = hashVoter(voterId);
      const had = target.ballots.some(b => b.h === vh);
      if (data.voteMode === 'single') data.restaurants.forEach(r => { r.ballots = r.ballots.filter(b => b.h !== vh); });
      else target.ballots = target.ballots.filter(b => b.h !== vh);
      if (!had) target.ballots.push({ h: vh, t: Date.now() });
      changed();
      return !had;
    }
  };
}

const store = createStore(
  SUPABASE_URL && SUPABASE_KEY ? createSupabasePersistence(SUPABASE_URL, SUPABASE_KEY)
    : SERVICE_ACCOUNT && SHEET_ID ? createSheetsPersistence(SERVICE_ACCOUNT, SHEET_ID)
    : createFilePersistence(DATA_FILE));

// ---------------- HTTP (built-in, zero dependencies) ----------------

const PUBLIC_HTML = path.join(__dirname, 'public', 'index.html');

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1e6) { req.destroy(); reject(Object.assign(new Error('Payload too large'), { status: 413 })); }
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// Small in-memory rate limiter for write requests.
const hits = new Map();
function rateLimited(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const key = fwd || req.socket.remoteAddress || 'x', now = Date.now();
  const rec = hits.get(key) || { n: 0, t: now };
  if (now - rec.t > 60000) { rec.n = 0; rec.t = now; }
  rec.n++; hits.set(key, rec);
  return rec.n > 120;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > 120000) hits.delete(k); }, 60000).unref();

async function handle(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const m = req.method;

  if (m === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(PUBLIC_HTML, 'utf8'));
  }
  if (m === 'GET' && pathname === '/healthz') return sendJson(res, 200, { ok: true, storage: store.kind });
  if (pathname.startsWith('/api/')) await store.ensureRestored(m !== 'GET');
  // Full export for the GitHub backup job (restaurants, links, anonymous vote hashes).
  if (m === 'GET' && pathname === '/api/backup') return sendJson(res, 200, store.backup());
  if (!pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
  if (m !== 'GET' && rateLimited(req)) return sendJson(res, 429, { error: '操作太頻繁，請稍後再試' });

  const body = (m === 'GET' || m === 'HEAD') ? {} : await readJsonBody(req);
  const voterId = cleanVoterId(req.headers['x-voter-id'] || body.voterId);
  const state = () => store.getState(voterId);

  if (m === 'GET' && pathname === '/api/state') return sendJson(res, 200, await state());

  if (m === 'PATCH' && pathname === '/api/poll') {
    const f = {};
    if (typeof body.title === 'string' && body.title.trim()) f.title = body.title.trim().slice(0, 80);
    if (typeof body.description === 'string') f.description = body.description.trim().slice(0, 140);
    if (body.voteMode === 'multi' || body.voteMode === 'single') f.voteMode = body.voteMode;
    if (body.sortBy === 'votes' || body.sortBy === 'newest') f.sortBy = body.sortBy;
    await store.updatePoll(f);
    return sendJson(res, 200, await state());
  }

  if (m === 'DELETE' && pathname === '/api/restaurants') {
    await store.clearRestaurants();
    return sendJson(res, 200, await state());
  }

  if (m === 'POST' && pathname === '/api/restaurants') {
    const resolved = await resolveGoogleMapsInput(body.input || body.url || '');
    if (!resolved) return sendJson(res, 400, { error: '請輸入有效的 Google Maps 連結' });
    const item = {
      id: 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      name: String(resolved.name).slice(0, 200),
      address: String(resolved.address || '').slice(0, 300),
      url: String(resolved.url).slice(0, 2000),
      createdAt: Date.now()
    };
    await store.addRestaurant(item);
    return sendJson(res, 201, { item: { ...item, votes: 0, voters: [] }, state: await state() });
  }

  const voteMatch = pathname.match(/^\/api\/restaurants\/([^/]+)\/vote$/);
  if (m === 'POST' && voteMatch) {
    if (!voterId) return sendJson(res, 400, { error: 'Missing voterId' });
    const addedVote = await store.toggleVote(decodeURIComponent(voteMatch[1]), voterId);
    if (addedVote === null) return sendJson(res, 404, { error: 'Restaurant not found' });
    return sendJson(res, 200, { addedVote, state: await state() });
  }

  const itemMatch = pathname.match(/^\/api\/restaurants\/([^/]+)$/);
  if (itemMatch) {
    const id = decodeURIComponent(itemMatch[1]);
    if (m === 'PATCH') {
      const f = {};
      if (typeof body.name === 'string' && body.name.trim()) f.name = body.name.trim().slice(0, 60);
      if (typeof body.address === 'string') f.address = body.address.trim().slice(0, 120);
      if (typeof body.url === 'string' && body.url.trim()) f.url = body.url.trim().slice(0, 2000);
      if (!(await store.updateRestaurant(id, f))) return sendJson(res, 404, { error: 'Restaurant not found' });
      const s = await state();
      return sendJson(res, 200, { item: s.restaurants.find(r => r.id === id), state: s });
    }
    if (m === 'DELETE') {
      if (!(await store.deleteRestaurant(id))) return sendJson(res, 404, { error: 'Restaurant not found' });
      return sendJson(res, 200, { state: await state() });
    }
  }

  return sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status >= 500 ? 'Internal Server Error' : err.message });
  });
});

store.init()
  .then(() => {
    server.listen(PORT, () => console.log('Restaurant Vote Server running on :' + PORT + ' (storage: ' + store.kind + ')'));
    if (store.kind === 'google-sheets') {
      setInterval(() => store.reload().catch(e => console.error('Reload failed:', e.message)), 60000).unref();
    }
  })
  .catch(err => {
    console.error('Storage init failed:', err.message);
    if (store.persistence.clientEmail) console.error('Make sure the spreadsheet is shared (Editor) with ' + store.persistence.clientEmail);
    process.exit(1);
  });

// Persist pending changes before Render stops / sleeps the instance.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    store.flush().catch(() => {}).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
