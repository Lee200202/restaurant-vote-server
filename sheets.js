'use strict';
// Minimal zero-dependency Google Sheets client (service account JWT auth).

const crypto = require('crypto');

function parseServiceAccount(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('GOOGLE_SERVICE_ACCOUNT is empty');
  let json;
  if (text.startsWith('{')) json = JSON.parse(text);
  else json = JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
  if (!json.client_email || !json.private_key) throw new Error('Service account JSON is missing client_email / private_key');
  json.private_key = json.private_key.replace(/\\n/g, '\n');
  return json;
}

const b64url = buf => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function createSheetsClient(serviceAccountRaw) {
  const sa = parseServiceAccount(serviceAccountRaw);
  let token = null;
  let tokenExp = 0;

  async function getToken() {
    const now = Math.floor(Date.now() / 1000);
    if (token && now < tokenExp - 60) return token;
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64url(JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    }));
    const signature = b64url(crypto.createSign('RSA-SHA256').update(header + '.' + claim).sign(sa.private_key));
    const res = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + header + '.' + claim + '.' + signature
    });
    const data = await res.json();
    if (!res.ok) throw new Error('Google auth failed: ' + (data.error_description || data.error || res.status));
    token = data.access_token;
    tokenExp = now + (data.expires_in || 3600);
    return token;
  }

  async function api(method, url, body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: { Authorization: 'Bearer ' + (await getToken()), 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      const msg = (data.error && data.error.message) || ('HTTP ' + res.status);
      throw Object.assign(new Error('Google Sheets API: ' + msg), { status: res.status });
    }
  }

  const API = process.env.SHEETS_API_BASE || 'https://sheets.googleapis.com'; // override only for tests
  const base = id => API + '/v4/spreadsheets/' + encodeURIComponent(id);

  return {
    clientEmail: sa.client_email,
    create: title => api('POST', API + '/v4/spreadsheets', { properties: { title } }),
    meta: id => api('GET', base(id) + '?fields=sheets.properties'),
    batchUpdate: (id, requests) => api('POST', base(id) + ':batchUpdate', { requests }),
    batchGet: (id, ranges) => api('GET', base(id) + '/values:batchGet?' + ranges.map(r => 'ranges=' + encodeURIComponent(r)).join('&') + '&valueRenderOption=UNFORMATTED_VALUE'),
    batchClear: (id, ranges) => api('POST', base(id) + '/values:batchClear', { ranges }),
    batchWrite: (id, data) => api('POST', base(id) + '/values:batchUpdate', { valueInputOption: 'RAW', data })
  };
}

module.exports = { createSheetsClient };
