'use strict';
// Tiny in-memory imitation of the Google Sheets REST API (only the calls sheets.js uses), for tests.
const http = require('http');
const tabs = {}; // title -> 2D array
const tabOf = r => { const m = decodeURIComponent(r).match(/^'(.+)'!/); return m ? m[1] : r; };
const trim = rows => {
  const out = rows.map(r => { const c = r.slice(); while (c.length && (c[c.length - 1] === '' || c[c.length - 1] == null)) c.pop(); return c; });
  while (out.length && !out[out.length - 1].length) out.pop();
  return out;
};
let writes = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/token') return send(200, { access_token: 'mock', expires_in: 3600 });
    if (u.pathname === '/_debug') return send(200, { tabs, writes });
    if (req.headers.authorization !== 'Bearer mock') return send(401, { error: { message: 'no auth' } });
    const b = body ? JSON.parse(body) : {};
    if (req.method === 'GET' && /\/v4\/spreadsheets\/[^/]+$/.test(u.pathname))
      return send(200, { sheets: Object.keys(tabs).map(title => ({ properties: { title } })) });
    if (u.pathname.endsWith('/values:batchGet')) {
      return send(200, { valueRanges: u.searchParams.getAll('ranges').map(r => {
        const t = tabOf(r); if (!tabs[t]) return { range: r };
        const v = trim(tabs[t]); return v.length ? { range: r, values: v } : { range: r };
      }) });
    }
    if (u.pathname.endsWith('/values:batchUpdate')) {
      writes++;
      for (const d of b.data) { const t = tabOf(d.range); const g = tabs[t] || (tabs[t] = []); d.values.forEach((row, i) => { g[i] = row.slice(); }); }
      return send(200, {});
    }
    if (u.pathname.endsWith(':batchUpdate')) { for (const r of b.requests) if (r.addSheet) tabs[r.addSheet.properties.title] = []; return send(200, {}); }
    send(404, { error: { message: 'mock: unknown ' + req.method + ' ' + u.pathname } });
  });
});
server.listen(Number(process.env.MOCK_PORT || 9555), () => console.log('mock sheets on', server.address().port));
