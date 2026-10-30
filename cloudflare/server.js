/**
 * DOPE レジ — Cloudflare Worker
 *
 * ・GET  /           レジ画面（register.html）を返す
 * ・POST /api/sync   端末の未送信の操作（会計・取消）を保存し、売上一覧を返す
 *
 * 必要な設定（Cloudflare のダッシュボード → Worker → 設定）
 * ・D1 データベースのバインディング: 変数名 DB
 */

const DAY_CUTOFF_HOURS = 6;
const JST_OFFSET_MS = 9 * 3600 * 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY, ts INTEGER NOT NULL, day TEXT NOT NULL,
    normal INTEGER NOT NULL DEFAULT 0, normal_ice INTEGER NOT NULL DEFAULT 0,
    ticket INTEGER NOT NULL DEFAULT 0, ticket_ice INTEGER NOT NULL DEFAULT 0,
    cups INTEGER NOT NULL, ice INTEGER NOT NULL, total INTEGER NOT NULL,
    received INTEGER, change INTEGER, drink_price INTEGER NOT NULL, ice_price INTEGER NOT NULL,
    voided INTEGER NOT NULL DEFAULT 0, voided_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`
];

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((q) => db.prepare(q)));
  schemaReady = true;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

// ---- helpers ---------------------------------------------------------------------
function bizDay(ts) {
  const d = new Date(ts + JST_OFFSET_MS - DAY_CUTOFF_HOURS * 3600000);
  return d.toISOString().slice(0, 10);
}
function num(v, fallback) {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? fallback : n;
}
async function getMeta(db, k) {
  const row = await db.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first();
  return row ? row.v : null;
}
function setMetaStmt(db, k, v) {
  return db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v));
}

/** 端末から届いた会計を検証し、金額はサーバー側で計算し直す */
function cleanSale(s) {
  if (!s || typeof s !== 'object') return null;
  const id = String(s.id || '');
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return null;
  const ts = Number(s.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const it = s.items || {};
  const n = (k) => Math.max(0, Math.min(999, Math.floor(Number(it[k]) || 0)));
  const items = { normal: n('normal'), normalIce: n('normalIce'), ticket: n('ticket'), ticketIce: n('ticketIce') };
  const cups = items.normal + items.normalIce + items.ticket + items.ticketIce;
  if (!cups) return null;
  const p = s.prices || {};
  const drink = Math.max(0, Math.floor(num(p.drink, 300)));
  const ice = Math.max(0, Math.floor(num(p.ice, 200)));
  const total = items.normal * drink + items.normalIce * (drink + ice) + items.ticketIce * ice;
  const received = s.received === null || s.received === undefined || s.received === ''
    ? null : Math.max(0, Math.floor(Number(s.received) || 0));
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(s.day || '')) ? String(s.day) : bizDay(ts);
  return { id, ts, day, items, cups, ice: items.normalIce + items.ticketIce, total, received,
    change: received === null ? null : received - total, drink, icePrice: ice };
}

function rowToSale(r) {
  return {
    id: r.id, ts: r.ts, day: r.day,
    items: { normal: r.normal, normalIce: r.normal_ice, ticket: r.ticket, ticketIce: r.ticket_ice },
    cups: r.cups, ice: r.ice, total: r.total, received: r.received, change: r.change,
    prices: { drink: r.drink_price, ice: r.ice_price }, voided: !!r.voided
  };
}

// ---- API ------------------------------------------------------------------------
async function apiSync(body, env) {
  const db = env.DB;
  const ops = Array.isArray(body.ops) ? body.ops.slice(0, 300) : [];
  const applied = [];
  const stmts = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.type === 'add') {
      const s = cleanSale(op.sale);
      if (s) {
        // 同じ会計が二重に届いても 1 件だけ残す（電波が悪いときの再送対策）
        stmts.push(db.prepare(
          `INSERT OR IGNORE INTO sales (id, ts, day, normal, normal_ice, ticket, ticket_ice, cups, ice, total,
            received, change, drink_price, ice_price, voided, voided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`
        ).bind(s.id, s.ts, s.day, s.items.normal, s.items.normalIce, s.items.ticket, s.items.ticketIce,
          s.cups, s.ice, s.total, s.received, s.change, s.drink, s.icePrice));
      }
    } else if (op.type === 'void') {
      const voided = op.voided ? 1 : 0;
      stmts.push(db.prepare('UPDATE sales SET voided = ?, voided_at = ? WHERE id = ?')
        .bind(voided, voided ? Math.floor(num(op.at, Date.now())) : null, String(op.id || '')));
    }
    // 不正な操作も「処理済み」にして、端末の送信待ちに残り続けないようにする
    applied.push(String(op.opId || ''));
  }
  if (stmts.length) {
    stmts.push(db.prepare(
      `INSERT INTO meta (k, v) VALUES ('version', '1')
       ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)`));
    await db.batch(stmts);
  }
  const version = (await getMeta(db, 'version')) || '0';
  const res = { ok: true, applied, version };
  if (version !== body.version) {
    const { results } = await db.prepare('SELECT * FROM sales ORDER BY ts DESC').all();
    res.sales = results.map(rowToSale);
  }
  return json(res);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(PAGE_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }
      });
    }
    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
      if (!env.DB) return json({ ok: false, error: 'no_database' }, 500);
      let body = {};
      try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad_json' }, 400); }
      await ensureSchema(env.DB);
      if (url.pathname === '/api/sync') return apiSync(body, env);
    }
    return new Response('Not found', { status: 404 });
  }
};
