'use strict';
// Usage: BASE=http://localhost:3000 node test/smoke.js
const assert = require('assert');
const BASE = process.env.BASE || 'http://localhost:3000';
const A = 'anon_testaaaa1', B = 'anon_testbbbb2';
async function call(method, path, body, voter) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'X-Voter-Id': voter || A }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
(async () => {
  let r = await call('DELETE', '/api/restaurants'); assert.strictEqual(r.status, 200);
  r = await call('POST', '/api/restaurants', { input: 'https://www.google.com/maps/place/%E9%BC%8E%E6%B3%B0%E8%B1%90+%E4%BF%A1%E7%BE%A9%E5%BA%97/@25.03,121.52,17z' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data)); assert.strictEqual(r.data.item.name, '鼎泰豐 信義店');
  const id1 = r.data.item.id;
  r = await call('POST', '/api/restaurants', { input: 'https://maps.google.com/?q=x\n阜杭豆漿\n台北市中正區忠孝東路一段108號' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.data)); assert.strictEqual(r.data.item.name, '阜杭豆漿'); assert.ok(r.data.item.address.includes('忠孝東路'));
  const id2 = r.data.item.id;
  r = await call('GET', '/api/state'); assert.strictEqual(r.data.restaurants[0].id, id2); // newest first, like the original
  r = await call('POST', '/api/restaurants', { input: 'hello' }); assert.strictEqual(r.status, 400);
  // multi mode votes
  r = await call('POST', `/api/restaurants/${id1}/vote`, {}, A); assert.strictEqual(r.data.addedVote, true);
  r = await call('POST', `/api/restaurants/${id2}/vote`, {}, A); assert.strictEqual(r.data.addedVote, true);
  r = await call('POST', `/api/restaurants/${id1}/vote`, {}, B);
  let s = r.data.state; const f = id => s.restaurants.find(x => x.id === id);
  assert.strictEqual(f(id1).votes, 2); assert.strictEqual(f(id2).votes, 1);
  assert.deepStrictEqual(f(id1).voters, [B]); assert.deepStrictEqual(f(id2).voters, []); // anonymity: only own id visible
  r = await call('POST', `/api/restaurants/${id1}/vote`, {}, B); assert.strictEqual(r.data.addedVote, false);
  // single mode
  r = await call('PATCH', '/api/poll', { voteMode: 'single', sortBy: 'newest', title: '測試標題', description: '說明' });
  assert.strictEqual(r.data.voteMode, 'single'); assert.strictEqual(r.data.sortBy, 'newest'); assert.strictEqual(r.data.title, '測試標題');
  r = await call('POST', `/api/restaurants/${id1}/vote`, {}, B);
  r = await call('POST', `/api/restaurants/${id2}/vote`, {}, B); s = r.data.state;
  assert.strictEqual(f(id1).votes, 1); assert.strictEqual(f(id2).votes, 2);
  // edit / delete
  r = await call('PATCH', `/api/restaurants/${id2}`, { name: '新名字', address: '新地址', url: 'https://maps.google.com/?q=x' });
  s = r.data.state; assert.strictEqual(f(id2).name, '新名字'); assert.strictEqual(r.data.item.name, '新名字');
  r = await call('DELETE', `/api/restaurants/${id1}`); s = r.data.state; assert.strictEqual(s.restaurants.length, 1);
  r = await call('GET', '/api/state'); assert.strictEqual(r.data.restaurants.length, 1);
  r = await call('POST', '/api/restaurants/nope/vote', {}); assert.strictEqual(r.status, 404);
  // reset to defaults
  await call('DELETE', '/api/restaurants');
  await call('PATCH', '/api/poll', { voteMode: 'multi', sortBy: 'votes', title: '這週末聚餐去哪吃？', description: '貼上或拖曳 Google Maps 連結，點擊卡片可直接開啟地圖，右側匿名投票' });
  const html = await (await fetch(BASE + '/')).text(); assert.ok(html.includes('聚餐投票所'));
  console.log('ALL SMOKE TESTS PASSED');
})().catch(e => { console.error('FAILED', e); process.exit(1); });
