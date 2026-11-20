const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_HTML = path.join(__dirname, 'public', 'index.html');
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

const DEFAULT_STATE = {
  title: '這週末聚餐去哪吃？',
  description: '貼上或拖曳 Google Maps 連結，點擊卡片可直接開啟地圖，右側匿名投票',
  voteMode: 'multi',
  sortBy: 'votes',
  restaurants: []
};

// In-memory state backed by persistent data.json on disk
let state = loadStateFromDisk();

function loadStateFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.restaurants)) {
        return parsed;
      }
    }
  } catch (err) {
    console.error('Failed to read data.json, using default state:', err.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function saveStateToDisk() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write data.json:', err.message);
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Follow HTTP/HTTPS redirects server-side (e.g. maps.app.goo.gl -> google.com/maps/place/...)
function fetchWithRedirects(targetUrl, maxRedirects = 6) {
  return new Promise((resolve, reject) => {
    let currentUrl = targetUrl;
    let hops = 0;

    function requestOnce(urlStr) {
      let parsed;
      try {
        parsed = new URL(urlStr);
      } catch (e) {
        return reject(new Error('Invalid URL'));
      }
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.get(urlStr, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RestaurantVoteBot/1.0)',
          'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
        },
        timeout: 6000
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < maxRedirects) {
          hops += 1;
          const nextUrl = new URL(res.headers.location, urlStr).toString();
          res.resume();
          currentUrl = nextUrl;
          return requestOnce(nextUrl);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          if (body.length < 150000) body += chunk;
        });
        res.on('end', () => resolve({ finalUrl: currentUrl, html: body }));
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ finalUrl: currentUrl, html: '' });
      });
      req.on('error', () => resolve({ finalUrl: currentUrl, html: '' }));
    }

    requestOnce(currentUrl);
  });
}

function parseCoordinates(urlStr) {
  const exact = urlStr.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (exact) return { lat: parseFloat(exact[1]), lng: parseFloat(exact[2]) };
  const at = urlStr.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (at) return { lat: parseFloat(at[1]), lng: parseFloat(at[2]) };
  return null;
}

function extractMetaTag(html, attrName, attrValue) {
  if (!html) return '';
  const regex = new RegExp(
    `<meta[^>]+${attrName}=["']${attrValue}["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+${attrName}=["']${attrValue}["']`,
    'i'
  );
  const m = html.match(regex);
  return m ? decodeHtmlEntities((m[1] || m[2] || '').trim()) : '';
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

function parseNameFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const decodedPath = decodeURIComponent(u.pathname);
    const placeMatch = decodedPath.match(/\/place\/([^/@]+)/);
    if (placeMatch && placeMatch[1]) {
      return placeMatch[1].replace(/\+/g, ' ').trim();
    }
    const q = u.searchParams.get('query') || u.searchParams.get('q') || u.searchParams.get('name');
    if (q && q.trim().length > 1) return q.replace(/\+/g, ' ').trim();
  } catch (e) {
    // Ignore
  }
  return '';
}

function fetchJsonHttps(urlStr) {
  return new Promise(resolve => {
    const req = https.get(urlStr, {
      headers: { 'User-Agent': 'RestaurantVoteApp/1.0' },
      timeout: 5000
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function lookupWithGooglePlacesApi(query, coords) {
  if (!GOOGLE_MAPS_API_KEY || !query) return null;
  let endpoint = 'https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=' +
    encodeURIComponent(query) +
    '&inputtype=textquery&language=zh-TW&fields=name,formatted_address&key=' +
    encodeURIComponent(GOOGLE_MAPS_API_KEY);
  if (coords) {
    endpoint += `&locationbias=point:${coords.lat},${coords.lng}`;
  }
  const data = await fetchJsonHttps(endpoint);
  if (data && data.candidates && data.candidates[0]) {
    return {
      name: data.candidates[0].name || '',
      address: data.candidates[0].formatted_address || ''
    };
  }
  return null;
}

async function reverseGeocodeNominatim(coords) {
  if (!coords) return '';
  const endpoint = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(coords.lat)}&lon=${encodeURIComponent(coords.lng)}&accept-language=zh-TW`;
  const data = await fetchJsonHttps(endpoint);
  if (!data || !data.address) return '';
  const a = data.address;
  const parts = [
    a.postcode || '',
    a.city || a.county || '',
    a.town || a.suburb || a.city_district || '',
    a.village || a.neighbourhood || '',
    a.road || '',
    a.house_number ? `${a.house_number}號` : ''
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('') : '';
}

async function resolveGoogleMapsInput(rawInput) {
  const text = String(rawInput || '').trim();
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  let url = urlMatch ? urlMatch[0].replace(/[),.;]+$/, '') : '';
  if (!url && /^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(text)) {
    url = 'https://' + text.split(/\s+/)[0];
  }
  if (!url) return null;

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null;
  } catch (e) {
    return null;
  }

  // Extract any lines pasted alongside the URL
  const extraLines = text
    .replace(url, '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  let name = extraLines[0] || parseNameFromUrl(url);
  let address = extraLines.length >= 2 ? extraLines.slice(1).join(' ') : '';
  let finalUrl = url;

  // Expand short links or fetch metadata server-side when needed
  const host = parsedUrl.hostname.replace(/^www\./, '');
  const isShortMap = host === 'maps.app.goo.gl' || host === 'goo.gl';
  if (isShortMap || !name) {
    const resolved = await fetchWithRedirects(url);
    finalUrl = resolved.finalUrl || url;
    if (!name) {
      name = parseNameFromUrl(finalUrl);
    }
    if (!name && resolved.html) {
      const ogTitle = extractMetaTag(resolved.html, 'property', 'og:title');
      if (ogTitle) {
        const cleaned = ogTitle.split('·')[0].replace(/\s*-\s*Google\s*(Maps|地圖)\s*$/i, '').trim();
        if (cleaned && !/^Google\s*(Maps|地圖)$/i.test(cleaned)) {
          name = cleaned;
        }
      }
    }
    if (!address && resolved.html) {
      const ogTitle = extractMetaTag(resolved.html, 'property', 'og:title');
      if (ogTitle && ogTitle.includes('·')) {
        address = ogTitle.split('·').slice(1).join(' ').trim();
      }
    }
  }

  const coords = parseCoordinates(finalUrl) || parseCoordinates(url);

  // If server has GOOGLE_MAPS_API_KEY configured, enrich name & formatted_address via Google Places API
  if (GOOGLE_MAPS_API_KEY && name) {
    const placeInfo = await lookupWithGooglePlacesApi(name, coords);
    if (placeInfo) {
      if (placeInfo.name) name = placeInfo.name;
      if (placeInfo.address) address = placeInfo.address;
    }
  }

  if (!address && coords) {
    address = await reverseGeocodeNominatim(coords);
  }

  if (!name) {
    name = host === 'maps.app.goo.gl' ? 'Google Maps 餐廳' : host;
  }

  return { name, address, url: finalUrl };
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  try {
    // Serve frontend
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = fs.readFileSync(PUBLIC_HTML, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // GET /api/state
    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJson(res, 200, state);
    }

    // PATCH /api/poll (title, description, voteMode, sortBy)
    if (req.method === 'PATCH' && pathname === '/api/poll') {
      const body = await readJsonBody(req);
      if (typeof body.title === 'string' && body.title.trim()) state.title = body.title.trim().slice(0, 80);
      if (typeof body.description === 'string') state.description = body.description.trim().slice(0, 140);
      if (body.voteMode === 'multi' || body.voteMode === 'single') state.voteMode = body.voteMode;
      if (body.sortBy === 'votes' || body.sortBy === 'newest') state.sortBy = body.sortBy;
      saveStateToDisk();
      return sendJson(res, 200, state);
    }

    // DELETE /api/restaurants (clear all)
    if (req.method === 'DELETE' && pathname === '/api/restaurants') {
      state.restaurants = [];
      saveStateToDisk();
      return sendJson(res, 200, state);
    }

    // POST /api/restaurants (resolve Google Maps URL & persist)
    if (req.method === 'POST' && pathname === '/api/restaurants') {
      const body = await readJsonBody(req);
      const resolved = await resolveGoogleMapsInput(body.input || body.url || '');
      if (!resolved) {
        return sendJson(res, 400, { error: '請輸入有效的 Google Maps 連結' });
      }
      const newItem = {
        id: 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        name: resolved.name,
        address: resolved.address || '',
        url: resolved.url,
        votes: 0,
        voters: [],
        createdAt: Date.now()
      };
      state.restaurants.unshift(newItem);
      saveStateToDisk();
      return sendJson(res, 201, { item: newItem, state });
    }

    // POST /api/restaurants/:id/vote
    const voteMatch = pathname.match(/^\/api\/restaurants\/([^/]+)\/vote$/);
    if (req.method === 'POST' && voteMatch) {
      const id = decodeURIComponent(voteMatch[1]);
      const body = await readJsonBody(req);
      const voterId = String(body.voterId || '').trim();
      if (!voterId) return sendJson(res, 400, { error: 'Missing voterId' });

      const target = state.restaurants.find(r => r.id === id);
      if (!target) return sendJson(res, 404, { error: 'Restaurant not found' });

      if (!Array.isArray(target.voters)) target.voters = [];
      const hasVoted = target.voters.includes(voterId);
      let addedVote = false;

      if (state.voteMode === 'single') {
        state.restaurants.forEach(r => {
          if (!Array.isArray(r.voters)) r.voters = [];
          const idx = r.voters.indexOf(voterId);
          if (idx !== -1) {
            r.voters.splice(idx, 1);
            r.votes = Math.max(0, (r.votes || 0) - 1);
          }
        });
        if (!hasVoted) {
          target.voters.push(voterId);
          target.votes = (target.votes || 0) + 1;
          addedVote = true;
        }
      } else {
        if (hasVoted) {
          target.voters = target.voters.filter(v => v !== voterId);
          target.votes = Math.max(0, (target.votes || 0) - 1);
        } else {
          target.voters.push(voterId);
          target.votes = (target.votes || 0) + 1;
          addedVote = true;
        }
      }

      saveStateToDisk();
      return sendJson(res, 200, { addedVote, state });
    }

    // PATCH or DELETE /api/restaurants/:id
    const itemMatch = pathname.match(/^\/api\/restaurants\/([^/]+)$/);
    if (itemMatch) {
      const id = decodeURIComponent(itemMatch[1]);
      const item = state.restaurants.find(r => r.id === id);
      if (!item) return sendJson(res, 404, { error: 'Restaurant not found' });

      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        if (typeof body.name === 'string' && body.name.trim()) item.name = body.name.trim().slice(0, 60);
        if (typeof body.address === 'string') item.address = body.address.trim().slice(0, 120);
        if (typeof body.url === 'string' && body.url.trim()) item.url = body.url.trim();
        saveStateToDisk();
        return sendJson(res, 200, { item, state });
      }

      if (req.method === 'DELETE') {
        state.restaurants = state.restaurants.filter(r => r.id !== id);
        saveStateToDisk();
        return sendJson(res, 200, { state });
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'Internal Server Error' });
  }
});

server.listen(PORT, () => {
  console.log(`Restaurant Vote Server running on http://localhost:${PORT}`);
});
