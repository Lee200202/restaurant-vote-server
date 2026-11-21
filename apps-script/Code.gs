/**
 * 聚餐投票所 — 完整後端（Google 試算表 + Apps Script 網頁應用程式）
 *
 * 所有資料都寫在這份試算表裡，永久保存（另有試算表內建的版本記錄可回溯）：
 *   投票設定：標題、說明、投票規則、排序
 *   候選餐廳：每家餐廳一列（含目前票數）
 *   投票紀錄：每一張票一列（投票者只存加鹽雜湊值，看不出是誰）
 *   操作紀錄：新增 / 修改 / 刪除 / 清空 的歷史（只會往下累加）
 *
 * 部署：部署 → 新增部署 → 網頁應用程式；執行身分「我」，存取權「所有人」。
 * 第一次請先在編輯器執行 setup() 完成授權。
 */

var TAB_POLL = '投票設定';
var TAB_REST = '候選餐廳';
var TAB_VOTES = '投票紀錄';
var TAB_LOG = '操作紀錄';
var CACHE_KEY = 'state_v1';
var CACHE_SECONDS = 20; // 直接在試算表手動修改，最多 20 秒後會反映到網站

var DEFAULTS = {
  title: '這週末聚餐去哪吃？',
  description: '貼上或拖曳 Google Maps 連結，點擊卡片可直接開啟地圖，右側匿名投票',
  voteMode: 'multi',
  sortBy: 'votes'
};

// ---------------------------------------------------------------- entry points

// 補上空白的地址（可在編輯器手動執行）
function fillMissingAddresses() {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var data = loadFromSheet(), filled = [];
    data.restaurants.forEach(function (r) {
      if (r.address) return;
      var a = reverseGeocode(parseCoordinates(r.url));
      if (a) { r.address = a; filled.push(r.name + '：' + a); }
    });
    if (filled.length) { saveToSheet(data); appendLog('補上地址', filled.join('、')); putCache(data); }
    Logger.log(filled.length ? filled.join('\n') : '沒有需要補的地址');
  } finally { lock.releaseLock(); }
}

function setup() {
  ensureSheets();
  getSalt();
  UrlFetchApp.fetch('https://www.google.com/', { muteHttpExceptions: true });
  Logger.log('OK：分頁已建立，授權完成。');
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'state') return out({ ok: true, result: publicState(loadCached(), cleanVoter(p.voter)) });
    if (p.action === 'preview') { // resolve a pasted link to its Google Maps name + address (nothing is saved)
      var pv = resolveGoogleMapsInput(p.input || '');
      return out(pv ? { ok: true, result: pv } : { ok: false, error: '請輸入有效的 Google Maps 連結' });
    }
    if (p.action === 'health') {
      var d = loadFromSheet();
      return out({ ok: true, result: { storage: 'google-sheets', restaurants: d.restaurants.length, spreadsheet: SpreadsheetApp.getActive().getName() } });
    }
    return out({ ok: true, result: { service: 'restaurant-vote' } });
  } catch (err) {
    return out({ ok: false, error: errMsg(err) });
  }
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (x) { return out({ ok: false, error: 'Invalid JSON' }); }
  var method = String(req.method || '').toUpperCase();
  var path = String(req.path || '');
  var body = req.body || {};
  var voter = cleanVoter(req.voterId || body.voterId);

  // Slow network work happens before taking the lock.
  var resolved = null;
  if (method === 'POST' && path === '/api/restaurants') {
    resolved = resolveGoogleMapsInput(body.input || body.url || '');
    if (!resolved) return out({ ok: false, error: '請輸入有效的 Google Maps 連結' });
    // Name / address confirmed (and possibly corrected) in the page's preview take priority.
    if (typeof body.name === 'string' && body.name.trim()) resolved.name = body.name.trim().slice(0, 60);
    if (typeof body.address === 'string' && body.address.trim()) resolved.address = body.address.trim().slice(0, 120);
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return out({ ok: false, error: '目前人數較多，請再試一次' });
  try {
    var data = loadFromSheet(); // always the sheet itself (never the cache) before a change
    var r = route(method, path, body, voter, data, resolved);
    if (r.error) return out({ ok: false, error: r.error });
    if (r.changed) {
      saveToSheet(data);
      if (r.log) appendLog(r.log[0], r.log[1]);
      putCache(data);
    }
    return out({ ok: true, result: r.payload() });
  } catch (err) {
    return out({ ok: false, error: errMsg(err) });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- API (same as the original server)

function route(m, path, body, voter, data, resolved) {
  var state = function () { return publicState(data, voter); };
  var find = function (id) { for (var i = 0; i < data.restaurants.length; i++) if (data.restaurants[i].id === id) return data.restaurants[i]; return null; };
  var mm;

  if (m === 'GET' && path === '/api/state') return { payload: state };

  if (m === 'PATCH' && path === '/api/poll') {
    var changes = [];
    if (typeof body.title === 'string' && body.title.trim()) { data.title = body.title.trim().slice(0, 80); changes.push('標題=' + data.title); }
    if (typeof body.description === 'string') { data.description = body.description.trim().slice(0, 140); changes.push('說明'); }
    if (body.voteMode === 'multi' || body.voteMode === 'single') { data.voteMode = body.voteMode; changes.push('規則=' + body.voteMode); }
    if (body.sortBy === 'votes' || body.sortBy === 'newest') { data.sortBy = body.sortBy; changes.push('排序=' + body.sortBy); }
    return { changed: true, log: ['修改設定', changes.join('，')], payload: state };
  }

  if (m === 'DELETE' && path === '/api/restaurants') {
    var names = data.restaurants.map(function (r) { return r.name + '(' + r.ballots.length + '票)'; }).join('、');
    data.restaurants = [];
    return { changed: true, log: ['清空全部餐廳', names], payload: state };
  }

  if (m === 'POST' && path === '/api/restaurants') {
    var item = {
      id: 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      name: String(resolved.name).slice(0, 200),
      address: String(resolved.address || '').slice(0, 300),
      url: String(resolved.url).slice(0, 2000),
      createdAt: Date.now(),
      ballots: []
    };
    data.restaurants.unshift(item);
    return {
      changed: true, log: ['新增餐廳', item.name + ' ' + item.url],
      payload: function () { return { item: { id: item.id, name: item.name, address: item.address, url: item.url, votes: 0, voters: [], createdAt: item.createdAt }, state: state() }; }
    };
  }

  if (m === 'POST' && (mm = path.match(/^\/api\/restaurants\/([^\/]+)\/vote$/))) {
    if (!voter) return { error: 'Missing voterId' };
    var target = find(decodeURIComponent(mm[1]));
    if (!target) return { error: '找不到這家餐廳（可能已被刪除）' };
    var vh = hashVoter(voter);
    var had = target.ballots.some(function (b) { return b.h === vh; });
    if (data.voteMode === 'single') data.restaurants.forEach(function (r) { r.ballots = r.ballots.filter(function (b) { return b.h !== vh; }); });
    else target.ballots = target.ballots.filter(function (b) { return b.h !== vh; });
    if (!had) target.ballots.push({ h: vh, t: Date.now() });
    return { changed: true, payload: function () { return { addedVote: !had, state: state() }; } };
  }

  if ((mm = path.match(/^\/api\/restaurants\/([^\/]+)$/))) {
    var id = decodeURIComponent(mm[1]);
    var r0 = find(id);
    if (!r0) return { error: '找不到這家餐廳（可能已被刪除）' };
    if (m === 'PATCH') {
      if (typeof body.name === 'string' && body.name.trim()) r0.name = body.name.trim().slice(0, 60);
      if (typeof body.address === 'string') r0.address = body.address.trim().slice(0, 120);
      if (typeof body.url === 'string' && body.url.trim()) r0.url = body.url.trim().slice(0, 2000);
      return {
        changed: true, log: ['修改餐廳', r0.name + ' ' + r0.address + ' ' + r0.url],
        payload: function () { var s = state(); return { item: s.restaurants.filter(function (x) { return x.id === id; })[0], state: s }; }
      };
    }
    if (m === 'DELETE') {
      data.restaurants = data.restaurants.filter(function (x) { return x.id !== id; });
      return { changed: true, log: ['刪除餐廳', r0.name + '(' + r0.ballots.length + '票) ' + r0.url], payload: function () { return { state: state() }; } };
    }
  }
  return { error: 'Not found' };
}

// Public view: vote counts only; `voters` contains the caller's own anonymous id when they voted.
function publicState(data, voter) {
  var vh = voter ? hashVoter(voter) : '';
  return {
    title: data.title, description: data.description, voteMode: data.voteMode, sortBy: data.sortBy,
    restaurants: data.restaurants.map(function (r) {
      var mine = !!vh && r.ballots.some(function (b) { return b.h === vh; });
      return { id: r.id, name: r.name, address: r.address, url: r.url, votes: r.ballots.length, voters: mine ? [voter] : [], createdAt: r.createdAt };
    })
  };
}

// ---------------------------------------------------------------- storage (the spreadsheet)

function ensureSheets() {
  var ss = SpreadsheetApp.getActive();
  var spec = [
    [TAB_POLL, ['設定', '值'], 'A:B'],
    [TAB_REST, ['id', '餐廳名稱', '地址', 'Google Maps 連結', '建立時間戳(ms)', '票數', '建立時間'], 'A:D'],
    [TAB_VOTES, ['餐廳 id', '匿名投票者（雜湊）', '時間戳(ms)', '餐廳名稱', '投票時間'], 'A:B'],
    [TAB_LOG, ['時間', '動作', '內容'], 'A:C']
  ];
  var created = false;
  spec.forEach(function (s) {
    var sh = ss.getSheetByName(s[0]);
    if (!sh) {
      sh = ss.insertSheet(s[0]);
      sh.getRange(s[2]).setNumberFormat('@'); // text: ids / hashes / names never turn into numbers or dates
      sh.getRange(1, 1, 1, s[1].length).setValues([s[1]]).setFontWeight('bold');
      sh.setFrozenRows(1);
      created = true;
    }
  });
  if (created) {
    var first = ss.getSheets()[0];
    if (first.getName() !== TAB_POLL && first.getLastRow() === 0 && ss.getSheets().length > 4) ss.deleteSheet(first); // remove the empty default tab
    var poll = ss.getSheetByName(TAB_POLL);
    if (poll.getLastRow() < 2) writeTable(poll, ['設定', '值'], pollRows(DEFAULTS));
  }
  return ss;
}

function readRows(sh, width) {
  var n = sh.getLastRow() - 1;
  return n > 0 ? sh.getRange(2, 1, n, width).getValues() : [];
}

function loadFromSheet() {
  var ss = ensureSheets();
  var data = { title: DEFAULTS.title, description: DEFAULTS.description, voteMode: DEFAULTS.voteMode, sortBy: DEFAULTS.sortBy, restaurants: [] };
  readRows(ss.getSheetByName(TAB_POLL), 2).forEach(function (row) {
    var k = String(row[0]), v = row[1] == null ? '' : String(row[1]);
    if (k === 'title' && v.trim()) data.title = v;
    if (k === 'description') data.description = v;
    if (k === 'voteMode' && (v === 'multi' || v === 'single')) data.voteMode = v;
    if (k === 'sortBy' && (v === 'votes' || v === 'newest')) data.sortBy = v;
  });
  var byId = {};
  readRows(ss.getSheetByName(TAB_REST), 5).forEach(function (row) {
    var id = String(row[0] || ''), url = String(row[3] || '');
    if (!id || !url || byId[id]) return;
    var r = { id: id, name: String(row[1] || '未命名餐廳'), address: String(row[2] == null ? '' : row[2]), url: url, createdAt: Number(row[4]) || Date.now(), ballots: [] };
    byId[id] = r;
    data.restaurants.push(r);
  });
  readRows(ss.getSheetByName(TAB_VOTES), 3).forEach(function (row) {
    var r = byId[String(row[0] || '')], h = String(row[1] || '');
    if (r && h && !r.ballots.some(function (b) { return b.h === h; })) r.ballots.push({ h: h, t: Number(row[2]) || 0 });
  });
  return data;
}

function pollRows(d) {
  return [['title', d.title], ['description', d.description], ['voteMode', d.voteMode], ['sortBy', d.sortBy]].map(function (r) { return [r[0], safe(r[1])]; });
}

function saveToSheet(data) {
  var ss = ensureSheets();
  var rest = data.restaurants.map(function (r) { return [r.id, safe(r.name), safe(r.address), safe(r.url), r.createdAt, r.ballots.length, fmt(r.createdAt)]; });
  var votes = [];
  data.restaurants.forEach(function (r) { r.ballots.forEach(function (b) { votes.push([r.id, b.h, b.t, safe(r.name), fmt(b.t)]); }); });
  writeTable(ss.getSheetByName(TAB_POLL), ['設定', '值'], pollRows(data));
  writeTable(ss.getSheetByName(TAB_REST), ['id', '餐廳名稱', '地址', 'Google Maps 連結', '建立時間戳(ms)', '票數', '建立時間'], rest);
  writeTable(ss.getSheetByName(TAB_VOTES), ['餐廳 id', '匿名投票者（雜湊）', '時間戳(ms)', '餐廳名稱', '投票時間'], votes);
  SpreadsheetApp.flush();
}

// Overwrite in place, then clear only the leftover rows below: the sheet is never empty mid-write.
function writeTable(sh, header, rows) {
  var all = [header].concat(rows);
  sh.getRange(1, 1, all.length, header.length).setValues(all);
  var last = sh.getLastRow();
  if (last > all.length) sh.getRange(all.length + 1, 1, last - all.length, Math.max(header.length, sh.getLastColumn())).clearContent();
}

function appendLog(action, detail) {
  try {
    SpreadsheetApp.getActive().getSheetByName(TAB_LOG).appendRow([fmt(Date.now()), action, safe(String(detail || '').slice(0, 1000))]);
  } catch (e) { /* logging must never break a request */ }
}

function loadCached() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(CACHE_KEY);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* fall through */ } }
  var data = loadFromSheet();
  putCache(data);
  return data;
}

function putCache(data) {
  var s = JSON.stringify(data);
  if (s.length < 95000) CacheService.getScriptCache().put(CACHE_KEY, s, CACHE_SECONDS);
  else CacheService.getScriptCache().remove(CACHE_KEY);
}

// ---------------------------------------------------------------- helpers

function out(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function errMsg(err) { return String((err && err.message) || err); }
function cleanVoter(v) { v = String(v || '').trim(); return v && v.length <= 100 ? v : ''; }
function safe(s) { s = String(s == null ? '' : s); return /^[=+\-@]/.test(s) ? "'" + s : s; } // never let text become a formula
function fmt(ms) { return ms ? Utilities.formatDate(new Date(Number(ms)), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss') : ''; }

function getSalt() {
  var p = PropertiesService.getScriptProperties();
  var s = p.getProperty('VOTER_SALT');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('VOTER_SALT', s); }
  return s;
}

function hashVoter(v) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, getSalt() + ':' + v, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

// ---------------------------------------------------------------- Google Maps link resolution

function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
function splitUrl(u) {
  var m = String(u).match(/^(https?):\/\/([^\/?#]+)([^?#]*)(\?[^#]*)?/i);
  return m ? { protocol: m[1].toLowerCase(), host: m[2].toLowerCase(), path: m[3] || '/', query: m[4] || '' } : null;
}
function queryParam(query, name) {
  var m = query.match(new RegExp('[?&]' + name + '=([^&]*)'));
  return m ? safeDecode(m[1].replace(/\+/g, ' ')) : '';
}

function fetchWithRedirects(url) {
  var current = url, html = '';
  for (var hops = 0; hops < 7; hops++) {
    var res;
    try {
      res = UrlFetchApp.fetch(current, { followRedirects: false, muteHttpExceptions: true, headers: { 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' } });
    } catch (e) { break; }
    var code = res.getResponseCode();
    var h = res.getAllHeaders();
    var loc = h['Location'] || h['location'];
    if (Array.isArray(loc)) loc = loc[0];
    if (code >= 300 && code < 400 && loc) {
      if (!/^https?:/i.test(loc)) { var p = splitUrl(current); loc = p.protocol + '://' + p.host + (loc.charAt(0) === '/' ? '' : '/') + loc; }
      current = loc;
      continue;
    }
    html = res.getContentText().slice(0, 150000);
    break;
  }
  return { finalUrl: current, html: html };
}

function parseCoordinates(u) {
  var exact = u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (exact) return { lat: parseFloat(exact[1]), lng: parseFloat(exact[2]) };
  var at = u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (at) return { lat: parseFloat(at[1]), lng: parseFloat(at[2]) };
  return null;
}

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, function (_, hex) { return String.fromCharCode(parseInt(hex, 16)); })
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); });
}

function ogTitle(html) {
  if (!html) return '';
  var m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']|<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  return m ? decodeHtmlEntities((m[1] || m[2] || '').trim()) : '';
}

function parseNameFromUrl(u) {
  var p = splitUrl(u);
  if (!p) return '';
  var place = safeDecode(p.path).match(/\/place\/([^\/@]+)/);
  if (place && place[1]) return place[1].replace(/\+/g, ' ').trim();
  var q = queryParam(p.query, 'query') || queryParam(p.query, 'q') || queryParam(p.query, 'name');
  return q && q.trim().length > 1 ? q.trim() : '';
}

function reverseGeocode(c) {
  if (!c) return '';
  try { // Apps Script's built-in Google Maps geocoder (no API key needed)
    var g = Maps.newGeocoder().setLanguage('zh-TW').reverseGeocode(c.lat, c.lng);
    if (g && g.status === 'OK' && g.results && g.results[0]) return g.results[0].formatted_address.replace(/^\d{3,6}\s*/, '').replace(/^台灣/, '');
  } catch (e) { /* fall back below */ }
  try {
    var res = UrlFetchApp.fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' + c.lat + '&lon=' + c.lng + '&accept-language=zh-TW',
      { muteHttpExceptions: true, headers: { 'User-Agent': 'RestaurantVoteApp/1.0' } });
    var d = JSON.parse(res.getContentText());
    if (!d || !d.address) return '';
    var a = d.address;
    return [a.postcode || '', a.city || a.county || '', a.town || a.suburb || a.city_district || '', a.village || a.neighbourhood || '', a.road || '', a.house_number ? a.house_number + '號' : '']
      .filter(Boolean).join('');
  } catch (e) { return ''; }
}

function resolveGoogleMapsInput(rawInput) {
  var text = String(rawInput || '').trim();
  var urlMatch = text.match(/https?:\/\/[^\s]+/i);
  var url = urlMatch ? urlMatch[0].replace(/[),.;]+$/, '') : '';
  if (!url && /^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(text)) url = 'https://' + text.split(/\s+/)[0];
  if (!url) return null;
  var parsed = splitUrl(url);
  if (!parsed) return null;

  var extra = text.replace(url, '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  var name = extra[0] || parseNameFromUrl(url);
  var address = extra.length >= 2 ? extra.slice(1).join(' ') : '';
  var finalUrl = url;
  var host = parsed.host.replace(/^www\./, '');
  if (host === 'maps.app.goo.gl' || host === 'goo.gl' || !name) {
    var r = fetchWithRedirects(url);
    finalUrl = r.finalUrl || url;
    if (!name) name = parseNameFromUrl(finalUrl);
    var og = ogTitle(r.html);
    if (!name && og) {
      var cleaned = og.split('·')[0].replace(/\s*-\s*Google\s*(Maps|地圖)\s*$/i, '').trim();
      if (cleaned && !/^Google\s*(Maps|地圖)$/i.test(cleaned)) name = cleaned;
    }
    if (!address && og && og.indexOf('·') >= 0) address = og.split('·').slice(1).join(' ').trim();
  }
  if (!address) address = reverseGeocode(parseCoordinates(finalUrl) || parseCoordinates(url));
  if (!name) name = host === 'maps.app.goo.gl' ? 'Google Maps 餐廳' : host;
  return { name: name, address: address, url: finalUrl };
}
