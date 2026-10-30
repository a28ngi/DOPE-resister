/**
 * DOPE POS アシスタント — Gemini API（generateContent）を Worker から呼ぶ
 *
 * ・売上や商品の「読み取り」はここで D1 を読んで答える。
 * ・データを変える操作（取消・商品の変更・レジ開け/締め）はここでは実行しない。
 *   「提案」として画面に返し、スタッフが確認ボタンを押したときだけ端末が通常の操作として記録する。
 * ・カートに商品を入れる・画面を切り替える操作は、そのまま画面に反映する（取り消しやすいので）。
 *
 * 必要な設定: wrangler secret put GEMINI_API_KEY
 * 任意の設定: AI_MODEL（既定 gemini-3.8-flash）, AI_DAILY_REQUESTS（1 日に Gemini を呼ぶ回数の上限・既定 300）
 */

// 無料枠で使える中でいちばん賢い Flash。無料枠では送った内容が Google の製品改善に使われる。
const DEFAULT_MODEL = 'gemini-3.8-flash';
// 無料枠は混雑すると 503 / 429 を返すことがある。そのときは同じく無料の軽いモデルに切り替える。
const FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash-lite'];
const CALL_TIMEOUT_MS = 20000;
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const MAX_HISTORY = 16;
const MAX_STEPS = 8;
const JST_OFFSET_MS = 9 * 3600 * 1000;
const DAY_CUTOFF_HOURS = 6;

const SYSTEM = `あなたは「DOPE POS」のアシスタントです。ライブ会場のドリンク販売の受付スタッフを手伝います。

# お店のこと
- 商品はドリンクと、バニラアイス付きのドリンク。ライブのチケットを持っている人はドリンク代が無料で、アイス代だけ払う（チケット区分の商品）。
- 営業日は朝 6 時で区切る（深夜 0〜6 時の会計は前日分）。時刻は日本時間。
- 現金とキャッシュレスの両方を受け付ける。レジ開けで準備金を記録し、締めで現金を数えて過不足を出す。

# できること
- 売上・会計・商品・レジ締めの状況を、ツールで実際のデータを見てから答える。数字を推測で答えない。
- お客さんの注文を聞いて、レジのカートに入れる（set_cart）。スタッフが会計ボタンを押す。
- 会計の取消、商品の追加・値段変更・非表示、レジ開け・締めを「提案」する。提案はスタッフが画面のボタンで確定するまで実行されない。提案したら、確認ボタンを押せば反映されることを短く伝える。
- 画面を切り替える（navigate）。

# 答え方
- スタッフは接客中で忙しい。結論を先に、短く。必要なら箇条書き。
- 金額は「¥1,200」の形。
- 頼まれていない変更は提案しない。あいまいな依頼は、一番ありそうな解釈で進めて、その解釈を一言添える。
- 取消や値段の変更のように影響が大きい操作は、対象（時刻・金額・商品）をはっきり書いてから提案する。
- 端末にまだ送っていない会計がある場合、サーバーの数字に含まれていないことがある。文脈に未送信件数があれば、その旨を添える。`;

function bizDay(ts) {
  return new Date(ts + JST_OFFSET_MS - DAY_CUTOFF_HOURS * 3600000).toISOString().slice(0, 10);
}
function jstHour(ts) {
  return new Date(ts + JST_OFFSET_MS).getUTCHours();
}
function jstTime(ts) {
  return new Date(ts + JST_OFFSET_MS).toISOString().slice(11, 16);
}
const label = (l) => (l.option ? `${l.name}＋${l.option}` : l.name);

// ---- 利用回数 ---------------------------------------------------------------------

export const AI_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pos_ai_usage (
     day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0, cost_micro INTEGER NOT NULL DEFAULT 0,
     input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0)`
];

export async function aiUsage(env) {
  const db = env.DB;
  const day = await db.prepare('SELECT requests AS n FROM pos_ai_usage WHERE day = ?').bind(bizDay(Date.now())).first();
  return {
    enabled: !!env.GEMINI_API_KEY,
    model: env.AI_MODEL || DEFAULT_MODEL,
    todayRequests: day ? day.n : 0,
    dailyLimit: Number(env.AI_DAILY_REQUESTS || 300)
  };
}

async function recordUsage(db, u) {
  await db.prepare(
    `INSERT INTO pos_ai_usage (day, requests, input, output) VALUES (?, 1, ?, ?)
     ON CONFLICT(day) DO UPDATE SET requests = requests + 1, input = input + excluded.input, output = output + excluded.output`
  ).bind(bizDay(Date.now()), u.promptTokenCount || 0, (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)).run();
}

// ---- 読み取り -------------------------------------------------------------------

async function loadOrders(db, { from, to, includeVoided = false, limit = 5000 }) {
  let q = 'SELECT * FROM pos_orders WHERE 1=1';
  const args = [];
  if (from) { q += ' AND day >= ?'; args.push(from); }
  if (to) { q += ' AND day <= ?'; args.push(to); }
  if (!includeVoided) q += ' AND voided = 0';
  q += ' ORDER BY ts DESC LIMIT ?';
  args.push(limit);
  const { results } = await db.prepare(q).bind(...args).all();
  return results.map((r) => ({ ...r, lines: JSON.parse(r.lines) }));
}

function summarize(orders) {
  const s = { sales: 0, orders: orders.length, items: 0, ticketItems: 0, ticketDiscount: 0,
    byMethod: { cash: 0, cashless: 0, free: 0 }, byItem: {}, byHour: {}, byDay: {} };
  for (const o of orders) {
    s.sales += o.total;
    s.ticketDiscount += o.list_total - o.total;
    s.byMethod[o.method] = (s.byMethod[o.method] || 0) + o.total;
    s.byDay[o.day] = (s.byDay[o.day] || 0) + o.total;
    const h = jstHour(o.ts);
    for (const l of o.lines) {
      s.items += l.qty;
      if (l.group === 'ticket') s.ticketItems += l.qty;
      const k = `${l.group === 'ticket' ? 'チケット' : '通常'} ${label(l)}`;
      const r = (s.byItem[k] ||= { qty: 0, sales: 0 });
      r.qty += l.qty; r.sales += l.price * l.qty;
      s.byHour[h] = (s.byHour[h] || 0) + l.qty;
    }
  }
  const paid = orders.filter((o) => o.total > 0).length;
  s.averagePerPaidOrder = paid ? Math.round(s.sales / paid) : 0;
  return s;
}

async function loadJsonRows(db, table) {
  const { results } = await db.prepare(`SELECT data FROM ${table}`).all();
  return results.map((r) => JSON.parse(r.data));
}

// ---- 実行 -----------------------------------------------------------------------

export async function runAgent(body, env) {
  if (!env.GEMINI_API_KEY) {
    return { ok: false, error: 'no_key', message: 'Gemini の API キーが設定されていません（wrangler secret put GEMINI_API_KEY）。' };
  }
  const usage = await aiUsage(env);
  if (usage.todayRequests >= usage.dailyLimit) {
    return { ok: false, error: 'limit_day', message: `今日の AI の上限（${usage.dailyLimit} 回）に達しました。朝 6 時に戻ります。` };
  }

  const db = env.DB;
  const actions = [];
  const propose = (a, done) => { actions.push(a); return done; };
  const PROPOSED = '提案を画面に出しました。スタッフが確認ボタンを押すと実行されます。';

  const tools = [
    tool({
      name: 'get_sales_summary',
      description: '期間の売上の集計を返す。売上・会計数・出た数・チケット特典額・支払い方法別・商品別・時間帯別（日本時間の時）・日別。取消した会計は含まない。日付を省くと今日の営業日。',
      schema: {
        type: 'object',
        properties: {
          from_day: { type: 'string', description: '開始の営業日 YYYY-MM-DD' },
          to_day: { type: 'string', description: '終了の営業日 YYYY-MM-DD（含む）' },
          all_time: { type: 'boolean', description: 'true なら全期間' }
        },
        additionalProperties: false
      },
      run: async ({ from_day, to_day, all_time }) => {
        const today = bizDay(Date.now());
        const from = all_time ? null : from_day || today;
        const to = all_time ? null : to_day || from_day || today;
        const orders = await loadOrders(db, { from, to });
        return JSON.stringify({ period: all_time ? '全期間' : `${from}〜${to}`, ...summarize(orders) });
      }
    }),
    tool({
      name: 'list_orders',
      description: '会計の一覧を新しい順に返す。取消の対象を探すときや「さっきの会計」を確認するときに使う。',
      schema: {
        type: 'object',
        properties: {
          day: { type: 'string', description: '営業日 YYYY-MM-DD。省くと今日' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: '件数（既定 20）' },
          include_voided: { type: 'boolean' },
          amount: { type: 'integer', description: 'この合計金額の会計だけ' }
        },
        additionalProperties: false
      },
      run: async ({ day, limit = 20, include_voided = false, amount }) => {
        const d = day || bizDay(Date.now());
        let orders = await loadOrders(db, { from: d, to: d, includeVoided: include_voided, limit: 500 });
        if (amount != null) orders = orders.filter((o) => o.total === amount);
        return JSON.stringify(orders.slice(0, limit).map((o) => ({
          id: o.id, time: jstTime(o.ts), total: o.total, method: o.method, tendered: o.tendered, change: o.change,
          items: o.lines.map((l) => `${l.group === 'ticket' ? '[チケット]' : ''}${label(l)}×${l.qty}`).join(', '),
          device: o.device || null, voided: !!o.voided, void_reason: o.void_reason || null
        })));
      }
    }),
    tool({
      name: 'get_items',
      description: '商品の一覧（id・名前・オプション・値段・定価・区分・表示中か）を返す。カートに入れる前や商品を変える前に使う。',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => JSON.stringify((await loadJsonRows(db, 'pos_items')).filter((i) => !i.deleted)
        .sort((a, b) => a.sort - b.sort)
        .map(({ id, name, option, price, listPrice, group, active }) => ({ id, name, option, price, listPrice, group, active })))
    }),
    tool({
      name: 'get_register_status',
      description: 'レジ開け・締めの状況。営業中なら準備金・現金売上・あるはずの現金を、過去の締めなら過不足を返す。',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const shifts = (await loadJsonRows(db, 'pos_shifts')).sort((a, b) => b.openedAt - a.openedAt);
        const open = shifts.find((s) => !s.closedAt);
        let current = null;
        if (open) {
          const { results } = await db.prepare(
            `SELECT method, SUM(total) AS t, COUNT(*) AS n FROM pos_orders WHERE shift_id = ? AND voided = 0 GROUP BY method`).bind(open.id).all();
          const by = Object.fromEntries(results.map((r) => [r.method, r.t]));
          current = { id: open.id, opened_at: jstTime(open.openedAt), float: open.float, cash_sales: by.cash || 0,
            cashless_sales: by.cashless || 0, expected_cash: open.float + (by.cash || 0) };
        }
        return JSON.stringify({
          open: current,
          past: shifts.filter((s) => s.closedAt).slice(0, 5).map((s) => ({
            day: bizDay(s.openedAt), opened: jstTime(s.openedAt), closed: jstTime(s.closedAt), float: s.float,
            counted: s.counted, expected: s.expected, difference: (s.counted ?? 0) - (s.expected ?? 0), note: s.note || null
          }))
        });
      }
    }),
    tool({
      name: 'set_cart',
      description: 'レジのカートを指定した中身に置き換え、レジ画面を開く。お客さんの注文を聞き取ったときに使う。item_id は get_items の id。会計はスタッフが行う。',
      schema: {
        type: 'object',
        properties: {
          lines: {
            type: 'array',
            items: {
              type: 'object',
              properties: { item_id: { type: 'string' }, qty: { type: 'integer', minimum: 1, maximum: 99 } },
              required: ['item_id', 'qty'], additionalProperties: false
            }
          }
        },
        required: ['lines'], additionalProperties: false
      },
      run: async ({ lines }) => {
        const items = Object.fromEntries((await loadJsonRows(db, 'pos_items')).map((i) => [i.id, i]));
        const bad = lines.filter((l) => !items[l.item_id] || items[l.item_id].deleted);
        if (bad.length) return `存在しない商品 id: ${bad.map((b) => b.item_id).join(', ')}。get_items で確認してください。`;
        actions.push({ type: 'set_cart', lines });
        const total = lines.reduce((a, l) => a + items[l.item_id].price * l.qty, 0);
        return `カートに入れました（合計 ¥${total.toLocaleString('ja-JP')}）。スタッフが会計します。`;
      }
    }),
    tool({
      name: 'navigate',
      description: '画面を切り替える。register=レジ, history=履歴, stats=集計, close=レジ締め, settings=設定。',
      schema: {
        type: 'object',
        properties: { view: { type: 'string', enum: ['register', 'history', 'stats', 'close', 'settings'] } },
        required: ['view'], additionalProperties: false
      },
      run: async ({ view }) => { actions.push({ type: 'navigate', view }); return `${view} を開きます。`; }
    }),
    tool({
      name: 'propose_void',
      description: '会計の取消（voided=true）または取消を戻す（voided=false）ことを提案する。order_id は list_orders の id。',
      schema: {
        type: 'object',
        properties: {
          order_id: { type: 'string' }, voided: { type: 'boolean' },
          reason: { type: 'string', description: '取消の理由（例: 打ち間違い・返金した）' }
        },
        required: ['order_id', 'voided'], additionalProperties: false
      },
      run: async ({ order_id, voided, reason }) => {
        const o = await db.prepare('SELECT id, ts, total, lines, voided FROM pos_orders WHERE id = ?').bind(order_id).first();
        if (!o) return '該当する会計がありません。list_orders で id を確認してください。';
        const summary = `${jstTime(o.ts)} ¥${o.total.toLocaleString('ja-JP')}（${JSON.parse(o.lines).map((l) => `${label(l)}×${l.qty}`).join('、')}）`;
        return propose({ type: 'void', id: o.id, voided, reason: reason || '打ち間違い', summary }, PROPOSED);
      }
    }),
    tool({
      name: 'propose_item',
      description: '商品の追加・変更・非表示・削除を提案する。既存の商品を変えるときは item_id を渡し、変える項目だけ書く。新しい商品は item_id を省く。',
      schema: {
        type: 'object',
        properties: {
          item_id: { type: 'string' }, name: { type: 'string' }, option: { type: 'string' },
          price: { type: 'integer', minimum: 0 }, list_price: { type: 'integer', minimum: 0 },
          group: { type: 'string', enum: ['regular', 'ticket'] }, active: { type: 'boolean' }, deleted: { type: 'boolean' }
        },
        additionalProperties: false
      },
      run: async (p) => {
        let cur = null;
        if (p.item_id) {
          const row = await db.prepare('SELECT data FROM pos_items WHERE id = ?').bind(p.item_id).first();
          if (!row) return '該当する商品がありません。get_items で id を確認してください。';
          cur = JSON.parse(row.data);
        }
        const next = { ...(cur || { name: 'ドリンク', option: '', price: 0, listPrice: 0, group: 'regular', active: true }) };
        for (const [k, v] of Object.entries({ name: p.name, option: p.option, price: p.price, listPrice: p.list_price, group: p.group, active: p.active, deleted: p.deleted })) {
          if (v !== undefined) next[k] = v;
        }
        if (p.price !== undefined && p.list_price === undefined && next.group === 'regular') next.listPrice = p.price;
        next.listPrice = Math.max(next.listPrice || 0, next.price || 0);
        return propose({ type: 'item', item: next, before: cur }, PROPOSED);
      }
    }),
    tool({
      name: 'propose_open_register',
      description: 'レジ開け（準備金の記録）を提案する。',
      schema: {
        type: 'object', properties: { float: { type: 'integer', minimum: 0, description: '準備金（円）' } },
        required: ['float'], additionalProperties: false
      },
      run: async ({ float }) => propose({ type: 'open_shift', float }, PROPOSED)
    }),
    tool({
      name: 'propose_close_register',
      description: 'レジ締めを提案する。スタッフが数えた金種ごとの枚数を渡す。枚数がわからない場合は合計額だけでもよい。',
      schema: {
        type: 'object',
        properties: {
          counts: {
            type: 'object', description: '金種（円）ごとの枚数。例 {"10000":1,"1000":5}',
            properties: Object.fromEntries([10000, 5000, 1000, 500, 100, 50, 10].map((d) => [String(d), { type: 'integer', minimum: 0 }])),
            additionalProperties: false
          },
          counted_total: { type: 'integer', minimum: 0, description: '数えた現金の合計（枚数がないとき）' },
          note: { type: 'string' }
        },
        additionalProperties: false
      },
      run: async ({ counts, counted_total, note }) => propose({ type: 'close_shift', counts: counts || null, counted: counted_total ?? null, note: note || '' }, PROPOSED)
    })
  ];

  // 会話はテキストだけを保持する（端末が持ち、毎回送る）
  const history = (Array.isArray(body.messages) ? body.messages : []).slice(-MAX_HISTORY)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (history.length && history[0].role !== 'user') history.shift();
  if (!history.length || history[history.length - 1].role !== 'user') {
    return { ok: false, error: 'bad_request', message: '質問が空です。' };
  }
  const ctx = body.context || {};
  const now = Date.now();
  const contextNote = `[状況] 現在 ${bizDay(now)} ${jstTime(now)}（日本時間）。画面: ${String(ctx.view || 'register').slice(0, 20)}。` +
    `端末名: ${String(ctx.device || '未設定').slice(0, 30)}。未送信の操作: ${Number(ctx.pending) || 0} 件。` +
    (ctx.cart && ctx.cart.length ? `カート: ${JSON.stringify(ctx.cart).slice(0, 500)}。` : 'カートは空。');
  const last = history.pop();
  const contents = [
    ...history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    { role: 'user', parts: [{ text: `${contextNote}\n\n${last.content}` }] }
  ];

  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const model = env.AI_MODEL || DEFAULT_MODEL;
  const request = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.schema) })) }],
    generationConfig: { maxOutputTokens: 4096 }
  };

  // 最初の呼び出しで使えたモデルを、この依頼の最後まで使う（思考の署名はモデルごとなので途中で替えない）
  const candidates = [model, ...FALLBACK_MODELS.filter((m) => m !== model)];
  let active = null;
  for (let step = 0; step < MAX_STEPS; step++) {
    const tryModels = active ? [active, active] : candidates;
    let res = null, data = {}, lastStatus = 0, lastMsg = '';
    for (let k = 0; k < tryModels.length; k++) {
      if (k > 0) await new Promise((r) => setTimeout(r, 600 * k));
      try {
        res = await fetch(`${API_BASE}${tryModels[k]}:generateContent`, {
          method: 'POST',
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
          headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
          body: JSON.stringify({ ...request, contents })
        });
      } catch {
        res = null; lastStatus = 0; lastMsg = '';
        continue;
      }
      data = await res.json().catch(() => ({}));
      if (res.ok) { active = tryModels[k]; break; }
      lastStatus = res.status;
      lastMsg = String(data.error?.message || '').slice(0, 120);
      // 混雑・上限・一時的な失敗だけ次を試す。キーやリクエストの誤りはすぐ返す
      if (![429, 500, 502, 503, 504].includes(res.status)) break;
    }
    if (!res || !res.ok) {
      // ツールでの作業は済んでいて、最後の文章だけ作れなかった場合は、済んだ作業を成功として返す
      if (step > 0 && actions.length) {
        return { ok: true, text: actions.some((x) => x.type === 'set_cart') ? 'カートに入れました。' : '画面に出した内容を確認してください。', actions, model: active };
      }
      const msg = lastStatus === 429 ? '無料枠の回数上限に達しました。少し待ってからもう一度どうぞ。'
        : !lastStatus || lastStatus >= 500 ? 'AI が混み合っています。少し待ってからもう一度どうぞ。'
        : `AI の呼び出しに失敗しました（${lastStatus}${lastMsg ? ': ' + lastMsg : ''}）。`;
      return { ok: false, error: 'api', message: msg, actions };
    }
    await recordUsage(db, data.usageMetadata || {});
    const cand = data.candidates?.[0];
    const content = cand?.content;
    if (!content || !Array.isArray(content.parts)) {
      const blocked = data.promptFeedback?.blockReason || cand?.finishReason;
      return { ok: false, error: 'empty', message: blocked ? `応答がありませんでした（${blocked}）。` : '応答がありませんでした。', actions };
    }
    // 思考の署名（thoughtSignature）を壊さないよう、モデルの発言はそのまま履歴に戻す
    contents.push(content);
    const calls = content.parts.filter((p) => p.functionCall);
    if (!calls.length) {
      const text = content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
      return { ok: true, text: text || (actions.length ? '画面に反映しました。' : ''), actions, model: active, truncated: cand.finishReason === 'MAX_TOKENS' };
    }
    const results = [];
    for (const p of calls) {
      const { name, args, id } = p.functionCall;
      const t = byName[name];
      let out;
      try {
        out = t ? await t.run(args || {}) : `不明なツール: ${name}`;
      } catch (e) {
        out = `ツールの実行に失敗しました: ${String(e.message || e).slice(0, 200)}`;
      }
      results.push({ functionResponse: { name, ...(id ? { id } : {}), response: { result: out } } });
    }
    contents.push({ role: 'user', parts: results });
  }
  return { ok: true, text: '手順が多すぎたので途中で止めました。依頼を分けてもう一度どうぞ。', actions };
}

// ツールの定義（JSON Schema）を Gemini の parameters（OpenAPI のサブセット）に合わせる
function toGeminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties') continue;
    if (k === 'properties') {
      const props = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
      if (!Object.keys(props).length) continue;
      out.properties = props;
    } else if (k === 'items') out.items = toGeminiSchema(v);
    else out[k] = v;
  }
  if (out.type === 'object' && !out.properties) return undefined;
  return out;
}

function tool(def) {
  return def;
}
