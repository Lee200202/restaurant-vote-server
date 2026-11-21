/**
 * 聚餐投票所 — Google 試算表後端（Apps Script）
 * 貼到「試算表 → 擴充功能 → Apps Script」，把 TOKEN 改成你自己的長隨機字串，
 * 然後 部署 → 新增部署 → 網頁應用程式（執行身分：我；存取權：所有人）。
 * 同一個 TOKEN 也要設到 Render 的環境變數 APPS_SCRIPT_TOKEN。
 */
var TOKEN = 'PASTE_YOUR_LONG_RANDOM_TOKEN_HERE';
var STATE_SHEET = '_state';   // 完整資料（JSON 分段存放），伺服器讀寫用
var CHUNK = 40000;            // 單一儲存格上限 50000 字元

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad json' }); }
  if (!TOKEN || TOKEN.indexOf('PASTE_') === 0 || req.token !== TOKEN) return out({ ok: false, error: 'unauthorized' });
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var ss = SpreadsheetApp.getActive();
    if (req.action === 'load') return out({ ok: true, data: readState(ss) });
    if (req.action === 'save') { writeState(ss, req.data); return out({ ok: true }); }
    return out({ ok: false, error: 'bad action' });
  } finally {
    lock.releaseLock();
  }
}

function doGet() { return out({ ok: true, service: 'restaurant-vote-backend' }); }

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet(ss, name) { return ss.getSheetByName(name) || ss.insertSheet(name); }

function readState(ss) {
  var sh = ss.getSheetByName(STATE_SHEET);
  if (!sh || sh.getLastRow() < 1) return null;
  var parts = sh.getRange(1, 1, sh.getLastRow(), 1).getValues().map(function (r) { return String(r[0]); });
  var text = parts.join('');
  return text ? JSON.parse(text) : null;
}

function writeState(ss, data) {
  var json = JSON.stringify(data);
  var rows = [];
  for (var i = 0; i < json.length; i += CHUNK) rows.push([json.substring(i, i + CHUNK)]);
  var sh = sheet(ss, STATE_SHEET);
  sh.clearContents();
  sh.getRange(1, 1, rows.length, 1).setValues(rows);
  // 給人看的分頁（唯讀用途；修改請在網站上操作）
  var fmt = function (ms) { return ms ? Utilities.formatDate(new Date(Number(ms)), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss') : ''; };
  var rest = [['餐廳', '地址', 'Google Maps 連結', '票數', '建立時間']];
  var votes = [['餐廳', '匿名投票者（雜湊前 8 碼）', '投票時間']];
  (data.restaurants || []).forEach(function (r) {
    var b = r.ballots || [];
    rest.push([r.name, r.address, r.url, b.length, fmt(r.createdAt)]);
    b.forEach(function (x) { votes.push([r.name, String(x.h).substring(0, 8), fmt(x.t)]); });
  });
  var s1 = sheet(ss, '候選餐廳'); s1.clearContents(); s1.getRange(1, 1, rest.length, 5).setValues(rest);
  var s2 = sheet(ss, '投票紀錄'); s2.clearContents(); s2.getRange(1, 1, votes.length, 3).setValues(votes);
  var s3 = sheet(ss, '投票設定'); s3.clearContents();
  s3.getRange(1, 1, 5, 2).setValues([['設定', '值'], ['標題', data.title], ['說明', data.description], ['投票規則', data.voteMode], ['排序', data.sortBy]]);
}
