/**
 * DOPE POS — Cloudflare Worker
 *
 * 画面（public/ 以下）は Workers Static Assets で配信し、ここでは /api/* だけを処理する。
 *
 *   POST /api/sync   端末の未送信の操作を保存し、前回以降に変わった会計・商品・レジ締めを返す
 *
 * 端末はオフラインでも会計でき、操作は端末の送信待ちに溜まる。操作には端末が作った ID が付くので、
 * 同じ操作が何度届いても結果は 1 回分になる。
 *
 *   POST /api/ai     アシスタント（src/agent.js）
 *   POST /api/ai/usage  アシスタントの利用額
 *
 * 環境変数 PASSCODE を設定すると、そのコードを知っている端末だけが使える（未設定なら誰でも使える）。
 */

import { runAgent, aiUsage, AI_SCHEMA } from './agent.js';

const DAY_CUTOFF_HOURS = 6; // 深夜 0〜6 時の会計は前の営業日に入れる
const JST_OFFSET_MS = 9 * 3600 * 1000;
const MAX_OPS = 500;
const MAX_ROWS = 2000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pos_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO pos_meta (k, v) VALUES ('seq', 0)`,
  `CREATE TABLE IF NOT EXISTS pos_orders (
     id TEXT PRIMARY KEY, seq INTEGER NOT NULL, ts INTEGER NOT NULL, day TEXT NOT NULL,
     device TEXT NOT NULL DEFAULT '', shift_id TEXT,
     lines TEXT NOT NULL, total INTEGER NOT NULL, list_total INTEGER NOT NULL, qty INTEGER NOT NULL,
     method TEXT NOT NULL, tendered INTEGER, change INTEGER,
     voided INTEGER NOT NULL DEFAULT 0, void_reason TEXT, voided_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS pos_orders_seq ON pos_orders (seq)`,
  `CREATE TABLE IF NOT EXISTS pos_items (
     id TEXT PRIMARY KEY, seq INTEGER NOT NULL, data TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS pos_shifts (
     id TEXT PRIMARY KEY, seq INTEGER NOT NULL, data TEXT NOT NULL)`,
  ...AI_SCHEMA
];

// DOPE の商品。設定画面で変えるまではこの内容で始まる。
const DEFAULT_ITEMS = [
  { id: 'drink', name: 'ドリンク', option: '', price: 300, listPrice: 300, group: 'regular', sort: 10, active: true },
  { id: 'drink-ice', name: 'ドリンク', option: 'バニラアイス', price: 500, listPrice: 500, group: 'regular', sort: 20, active: true },
  { id: 'ticket', name: 'ドリンク', option: '', price: 0, listPrice: 300, group: 'ticket', sort: 30, active: true },
  { id: 'ticket-ice', name: 'ドリンク', option: 'バニラアイス', price: 200, listPrice: 500, group: 'ticket', sort: 40, active: true }
];

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((q) => db.prepare(q)));
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM pos_items').first();
  if (!n) {
    await db.batch(DEFAULT_ITEMS.flatMap((it) => [bumpSeq(db),
      db.prepare(`INSERT OR IGNORE INTO pos_items (id, seq, data) VALUES (?, ${SEQ}, ?)`).bind(it.id, JSON.stringify(it))]));
  }
  schemaReady = true;
}

// 書き込みのたびに seq を 1 つ進め、その値を行に付ける。端末は「前回の seq より後」だけを受け取る。
const SEQ = `(SELECT v FROM pos_meta WHERE k = 'seq')`;
function bumpSeq(db) {
  return db.prepare(`UPDATE pos_meta SET v = v + 1 WHERE k = 'seq'`);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function bizDay(ts) {
  return new Date(ts + JST_OFFSET_MS - DAY_CUTOFF_HOURS * 3600000).toISOString().slice(0, 10);
}
const int = (v, lo, hi, fallback = 0) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const str = (v, max) => String(v ?? '').slice(0, max);
const validId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{2,64}$/.test(v);

// ---- 検証 ------------------------------------------------------------------------
// 合計は端末の数字を信じず、明細から計算し直す。

function cleanOrder(o) {
  if (!o || !validId(o.id)) return null;
  const ts = int(o.ts, 1, 8.64e15, 0);
  if (!ts) return null;
  const lines = (Array.isArray(o.lines) ? o.lines : []).slice(0, 50).map((l) => ({
    itemId: str(l.itemId, 64), name: str(l.name, 40), option: str(l.option, 40), group: str(l.group, 20),
    price: int(l.price, 0, 1e6), listPrice: int(l.listPrice, 0, 1e6), qty: int(l.qty, 0, 999)
  })).filter((l) => l.qty > 0);
  if (!lines.length) return null;
  for (const l of lines) l.listPrice = Math.max(l.listPrice, l.price);
  const total = lines.reduce((a, l) => a + l.price * l.qty, 0);
  const listTotal = lines.reduce((a, l) => a + l.listPrice * l.qty, 0);
  const qty = lines.reduce((a, l) => a + l.qty, 0);
  const method = ['cash', 'cashless', 'free'].includes(o.method) ? o.method : (total ? 'cash' : 'free');
  const tendered = method === 'cash' && o.tendered != null && o.tendered !== '' ? int(o.tendered, 0, 1e7) : null;
  return {
    id: o.id, ts, day: bizDay(ts), device: str(o.device, 30), shiftId: validId(o.shiftId) ? o.shiftId : null,
    lines, total, listTotal, qty, method, tendered, change: tendered == null ? null : tendered - total
  };
}

function cleanItem(it) {
  if (!it || !validId(it.id)) return null;
  const price = int(it.price, 0, 1e6);
  return {
    id: it.id, name: str(it.name, 40).trim() || '商品', option: str(it.option, 40).trim(),
    price, listPrice: Math.max(price, int(it.listPrice, 0, 1e6, price)),
    group: it.group === 'ticket' ? 'ticket' : 'regular', sort: int(it.sort, -1e6, 1e6),
    active: it.active !== false, deleted: !!it.deleted
  };
}

function cleanShift(s) {
  if (!s || !validId(s.id)) return null;
  const counts = {};
  for (const d of [10000, 5000, 1000, 500, 100, 50, 10, 5, 1]) {
    if (s.counts && s.counts[d] != null) counts[d] = int(s.counts[d], 0, 99999);
  }
  return {
    id: s.id, openedAt: int(s.openedAt, 1, 8.64e15, Date.now()), openedBy: str(s.openedBy, 30),
    float: int(s.float, 0, 1e7), closedAt: s.closedAt ? int(s.closedAt, 1, 8.64e15) : null,
    closedBy: str(s.closedBy, 30), counts, counted: s.counted == null ? null : int(s.counted, 0, 1e8),
    expected: s.expected == null ? null : int(s.expected, 0, 1e8), note: str(s.note, 200)
  };
}

// ---- 読み出し --------------------------------------------------------------------

function rowToOrder(r) {
  return {
    id: r.id, seq: r.seq, ts: r.ts, day: r.day, device: r.device, shiftId: r.shift_id,
    lines: JSON.parse(r.lines), total: r.total, listTotal: r.list_total, qty: r.qty,
    method: r.method, tendered: r.tendered, change: r.change,
    voided: !!r.voided, voidReason: r.void_reason, voidedAt: r.voided_at
  };
}

async function changesSince(db, since) {
  const [orders, items, shifts] = await db.batch([
    db.prepare('SELECT * FROM pos_orders WHERE seq > ? ORDER BY seq LIMIT ?').bind(since, MAX_ROWS),
    db.prepare('SELECT id, seq, data FROM pos_items WHERE seq > ?').bind(since),
    db.prepare('SELECT id, seq, data FROM pos_shifts WHERE seq > ?').bind(since)
  ]);
  const o = orders.results.map(rowToOrder);
  const parse = (rows) => rows.map((r) => ({ ...JSON.parse(r.data), seq: r.seq }));
  const its = parse(items.results);
  const sh = parse(shifts.results);
  // 会計が上限まで来たときは、続きを次の同期で取りに来られるよう、返した最後の seq で止める
  const more = o.length === MAX_ROWS;
  const all = [...o, ...its, ...sh].map((x) => x.seq);
  const cursor = more ? o[o.length - 1].seq : (all.length ? Math.max(since, ...all) : since);
  return { orders: o, items: its.filter((x) => !more || x.seq <= cursor), shifts: sh.filter((x) => !more || x.seq <= cursor), cursor, more };
}

// ---- API ------------------------------------------------------------------------

async function apiSync(body, env) {
  const db = env.DB;
  const ops = Array.isArray(body.ops) ? body.ops.slice(0, MAX_OPS) : [];
  const stmts = [];
  const applied = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    applied.push(str(op.opId, 80)); // 不正な操作も処理済みにして、端末に残り続けないようにする
    if (op.type === 'order') {
      const o = cleanOrder(op.order);
      if (!o) continue;
      stmts.push(bumpSeq(db), db.prepare(
        `INSERT OR IGNORE INTO pos_orders (id, seq, ts, day, device, shift_id, lines, total, list_total, qty, method, tendered, change)
         VALUES (?, ${SEQ}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(o.id, o.ts, o.day, o.device, o.shiftId, JSON.stringify(o.lines), o.total, o.listTotal, o.qty,
        o.method, o.tendered, o.change));
    } else if (op.type === 'void') {
      if (!validId(op.id)) continue;
      const voided = op.voided ? 1 : 0;
      stmts.push(bumpSeq(db), db.prepare(
        `UPDATE pos_orders SET voided = ?, void_reason = ?, voided_at = ?, seq = ${SEQ} WHERE id = ?`
      ).bind(voided, voided ? str(op.reason, 100) : null, voided ? int(op.at, 1, 8.64e15, Date.now()) : null, op.id));
    } else if (op.type === 'item') {
      const it = cleanItem(op.item);
      if (!it) continue;
      stmts.push(bumpSeq(db), db.prepare(
        `INSERT INTO pos_items (id, seq, data) VALUES (?, ${SEQ}, ?)
         ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, data = excluded.data`
      ).bind(it.id, JSON.stringify(it)));
    } else if (op.type === 'shift') {
      const s = cleanShift(op.shift);
      if (!s) continue;
      stmts.push(bumpSeq(db), db.prepare(
        `INSERT INTO pos_shifts (id, seq, data) VALUES (?, ${SEQ}, ?)
         ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, data = excluded.data`
      ).bind(s.id, JSON.stringify(s)));
    }
  }
  if (stmts.length) await db.batch(stmts);
  const since = int(body.since, 0, Number.MAX_SAFE_INTEGER);
  return json({ ok: true, applied, serverTime: Date.now(), ...(await changesSince(db, since)) });
}

function authorized(request, env) {
  if (!env.PASSCODE) return true;
  return request.headers.get('x-passcode') === String(env.PASSCODE);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname === '/api/ping') return json({ ok: true, passcode: !!env.PASSCODE, authorized: authorized(request, env) });
    if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
    if (!authorized(request, env)) return json({ ok: false, error: 'passcode' }, 401);
    if (!env.DB) return json({ ok: false, error: 'no_database' }, 500);
    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }
    await ensureSchema(env.DB);
    if (url.pathname === '/api/sync') return apiSync(body || {}, env);
    if (url.pathname === '/api/ai') return json(await runAgent(body || {}, env));
    if (url.pathname === '/api/ai/usage') return json({ ok: true, ...(await aiUsage(env)) });
    return json({ ok: false, error: 'not_found' }, 404);
  }
};
