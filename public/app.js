// DOPE POS — 画面とデータ同期
//
// 端末の中に全データの写しを持ち、操作はまず端末に反映してから送信待ち（outbox）に積む。
// 電波がなくても会計でき、つながった時点でまとめて送る。サーバーからは前回以降の変更だけを受け取る。

const API = '/api';
const SYNC_MS = 5000;
const LS = { data: 'dopepos:data:v1', outbox: 'dopepos:outbox:v1', cart: 'dopepos:cart:v1', device: 'dopepos:device', pass: 'dopepos:pass', theme: 'dopepos:theme', ai: 'dopepos:ai:v1' };
const DAY_CUTOFF_HOURS = 6;
const DENOMS = [10000, 5000, 1000, 500, 100, 50, 10];
const VOID_REASONS = ['打ち間違い', '返金した', 'テスト', 'その他'];
const GROUPS = {
  regular: { label: '通常', note: (items) => priceNote(items) },
  ticket: { label: 'ライブチケット購入者', note: () => 'チケットを確認してからタップ' }
};
const METHODS = { cash: '現金', cashless: 'キャッシュレス', free: '無料' };

// ---- utils ----------------------------------------------------------------------
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const yen = (n) => '¥' + Math.round(n || 0).toLocaleString('ja-JP');
const pad = (n) => String(n).padStart(2, '0');
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const lsGet = (k, fb) => { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
function bizDay(ts) {
  const d = new Date(ts - DAY_CUTOFF_HOURS * 3600000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  const w = '日月火水木金土'[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${w})`;
}
const hm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const mdhm = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${hm(ts)}`; };
function itemLabel(x) { return x.option ? `${x.name}＋${x.option}` : x.name; }
function priceNote(items) {
  const base = items.find((i) => !i.option);
  const opt = items.find((i) => i.option);
  if (base && opt) return `1杯 ${yen(base.price)} ・ ${opt.option} ＋${yen(opt.price - base.price)}`;
  return '';
}

// ---- store ----------------------------------------------------------------------
const db = Object.assign({ cursor: 0, orders: {}, items: {}, shifts: {} }, lsGet(LS.data, {}));
let outbox = lsGet(LS.outbox, []);
let device = lsGet(LS.device, '') || '';
let passcode = lsGet(LS.pass, '') || '';
const ui = {
  view: 'register',
  cart: lsGet(LS.cart, {}),
  method: 'cash',
  tendered: null, // null = 未入力
  tenderedText: '',
  historyDay: null, historyQuery: '', openOrder: null,
  statsDay: null,
  counts: {},
  sync: { state: 'idle', last: 0, error: '' }
};

function save() { lsSet(LS.data, db); }
function saveOutbox() { lsSet(LS.outbox, outbox); }
function saveCart() { lsSet(LS.cart, ui.cart); }

// 操作を端末に反映し、送信待ちに積む
function commit(op) {
  op.opId = uid('op');
  applyLocal(op);
  outbox.push(op);
  saveOutbox();
  save();
  renderAll();
  syncSoon(0);
}
function applyLocal(op) {
  if (op.type === 'order') db.orders[op.order.id] = { ...op.order, pending: true };
  else if (op.type === 'void') {
    const o = db.orders[op.id];
    if (o) Object.assign(o, { voided: op.voided, voidReason: op.voided ? op.reason : null, voidedAt: op.voided ? op.at : null });
  } else if (op.type === 'item') db.items[op.item.id] = { ...op.item };
  else if (op.type === 'shift') db.shifts[op.shift.id] = { ...op.shift };
}

const items = () => Object.values(db.items).filter((i) => !i.deleted).sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id));
const activeItems = () => items().filter((i) => i.active);
const orders = () => Object.values(db.orders).sort((a, b) => b.ts - a.ts);
const liveOrders = () => orders().filter((o) => !o.voided);
const shifts = () => Object.values(db.shifts).sort((a, b) => b.openedAt - a.openedAt);
const openShift = () => shifts().find((s) => !s.closedAt) || null;

// ---- sync -----------------------------------------------------------------------
let syncTimer = 0;
let syncing = false;
function syncSoon(ms = SYNC_MS) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, ms);
}
async function sync() {
  clearTimeout(syncTimer);
  if (syncing) return syncSoon(500);
  if (document.hidden && !outbox.length) return syncSoon();
  syncing = true;
  setSync('busy');
  try {
    let more = true;
    while (more) {
      const ops = outbox.slice(0, 200);
      const res = await fetch(API + '/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-passcode': passcode },
        body: JSON.stringify({ since: db.cursor, ops })
      });
      if (res.status === 401) { syncing = false; setSync('error', 'パスコードが違います'); askPasscode(); return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const done = new Set(data.applied);
      outbox = outbox.filter((o) => !done.has(o.opId));
      saveOutbox();
      const pendingIds = new Set(outbox.filter((o) => o.type === 'order').map((o) => o.order.id));
      for (const o of data.orders) db.orders[o.id] = { ...o, pending: pendingIds.has(o.id) };
      // まだ送っていない取消は、サーバーの古い状態で上書きしない
      for (const op of outbox) if (op.type === 'void') applyLocal(op);
      for (const it of data.items) db.items[it.id] = it;
      for (const s of data.shifts) db.shifts[s.id] = s;
      db.cursor = data.cursor;
      save();
      more = data.more || outbox.length > 0;
      if (!data.more && outbox.length && !done.size) more = false;
    }
    ui.sync.last = Date.now();
    setSync(outbox.length ? 'pending' : 'ok');
    renderAll();
  } catch (e) {
    setSync(navigator.onLine === false ? 'offline' : 'error', String(e.message || e));
  } finally {
    syncing = false;
    syncSoon();
  }
}
function setSync(state, error = '') {
  ui.sync.state = state;
  ui.sync.error = error;
  const el = $('#sync');
  const n = outbox.length;
  const text = {
    idle: '接続中', busy: n ? `送信中 ${n}件` : '同期中', ok: '全端末で共有中',
    pending: `未送信 ${n}件`, offline: n ? `オフライン・未送信 ${n}件` : 'オフライン', error: n ? `未送信 ${n}件` : '接続エラー'
  }[state];
  el.dataset.s = state === 'busy' && !n && ui.sync.last ? 'ok' : state;
  $('span', el).textContent = state === 'busy' && !n && ui.sync.last ? '全端末で共有中' : text;
  el.title = error;
}

const COMPACT = window.matchMedia('(max-width:759px),(max-width:1099px) and (orientation:portrait)');
const compact = () => COMPACT.matches;
let payOpen = false;
COMPACT.addEventListener('change', () => renderRegister());

// ---- cart -----------------------------------------------------------------------
function cartLines() {
  const byId = Object.fromEntries(items().map((i) => [i.id, i]));
  return Object.entries(ui.cart)
    .filter(([id, q]) => q > 0 && byId[id])
    .map(([id, qty]) => ({ ...byId[id], qty }))
    .sort((a, b) => a.sort - b.sort);
}
function cartTotals() {
  const lines = cartLines();
  return {
    lines,
    total: lines.reduce((a, l) => a + l.price * l.qty, 0),
    listTotal: lines.reduce((a, l) => a + l.listPrice * l.qty, 0),
    qty: lines.reduce((a, l) => a + l.qty, 0)
  };
}
function addToCart(id, d) {
  ui.cart[id] = Math.max(0, Math.min(99, (ui.cart[id] || 0) + d));
  if (!ui.cart[id]) delete ui.cart[id];
  if (ui.tendered != null && ui.tenderedText === '') ui.tendered = null; // 金額が変わったら「ちょうど」などの選択は外す
  saveCart();
  renderRegister();
}
function clearCart() {
  ui.cart = {};
  ui.tendered = null;
  ui.tenderedText = '';
  ui.method = 'cash';
  saveCart();
}
function tenderOptions(total) {
  const out = [];
  for (const step of [500, 1000, 5000, 10000]) {
    const v = Math.ceil(total / step) * step;
    if (v > total && !out.includes(v)) out.push(v);
  }
  for (const bill of [1000, 5000, 10000]) if (bill > total && !out.includes(bill)) out.push(bill);
  return out.sort((a, b) => a - b).slice(0, 4);
}

function checkout() {
  const t = cartTotals();
  if (!t.qty) return;
  const method = t.total === 0 ? 'free' : ui.method;
  const tendered = method === 'cash' ? ui.tendered : null;
  if (tendered != null && tendered < t.total) return;
  const shift = openShift();
  const order = {
    id: uid('o'), ts: Date.now(), device, shiftId: shift ? shift.id : null,
    lines: t.lines.map((l) => ({ itemId: l.id, name: l.name, option: l.option, group: l.group, price: l.price, listPrice: l.listPrice, qty: l.qty })),
    total: t.total, listTotal: t.listTotal, qty: t.qty, method, tendered, change: tendered == null ? null : tendered - t.total,
    voided: false
  };
  order.day = bizDay(order.ts);
  commit({ type: 'order', order });
  payOpen = false;
  clearCart();
  renderRegister();
  showDone(order);
}

// ---- views ----------------------------------------------------------------------
// 中身が変わったときだけ書き換える。同期のたびに作り直すと、押している途中のボタンが消えてしまう。
function setHtml(el, html) {
  if (el._html === html) return false;
  el._html = html;
  el.innerHTML = html;
  return true;
}

function renderAll() {
  renderRegister();
  if (ui.view === 'history') renderHistory();
  if (ui.view === 'stats') renderStats();
  if (ui.view === 'close' && !$('#v-close').contains(document.activeElement)) renderClose();
  if (ui.view === 'settings' && !$('#v-settings').contains(document.activeElement)) renderSettings();
  if (ui.view === 'ai') renderAI();
  setSync(ui.sync.state, ui.sync.error);
}

function renderRegister() {
  const list = activeItems();
  const groups = ['regular', 'ticket'].map((g) => ({ g, list: list.filter((i) => i.group === g) })).filter((x) => x.list.length);
  const shift = openShift();
  setHtml($('#menu'), (groups.length ? groups.map(({ g, list }) => `
    <div class="group ${g}">
      <div class="group-head"><h2>${GROUPS[g].label}</h2><p>${esc(GROUPS[g].note(list))}</p></div>
      <div class="tiles">${list.map(tile).join('')}</div>
    </div>`).join('') : `<p class="menu-empty">商品がありません。「設定」で商品を追加してください。</p>`) +
    (shift ? '' : `<div class="shift-hint"><span>レジ開けがまだです。釣り銭の準備金を記録すると、締めで現金の過不足がわかります。</span><a class="btn sm" href="#close">レジ開け</a></div>`));

  const t = cartTotals();
  const typing = document.activeElement && document.activeElement.id === 'tenderInput';
  if (!t.total) payOpen = false;
  if (!typing) {
    // 金額を入力している間は作り直さない（キーボードが閉じないように）
    const inline = !compact();
    setHtml($('#cart'), `
      <div class="card">
        <div class="card-head"><h2>ご注文</h2>${t.qty ? '<button type="button" class="link" data-act="clear">すべてクリア</button>' : ''}</div>
        ${t.qty ? `<ul class="lines">${t.lines.map((l) => `
          <li class="line">
            <span class="line-name">${l.group === 'ticket' ? '<span class="tag">チケット</span>' : ''}${esc(l.name)}${l.option ? `<span class="opt">＋${esc(l.option)}</span>` : ''}</span>
            <span class="stepper"><button type="button" data-step="${esc(l.id)}" data-d="-1" aria-label="1つ減らす">−</button><span>${l.qty}</span><button type="button" data-step="${esc(l.id)}" data-d="1" aria-label="1つ増やす">＋</button></span>
            <span class="line-amt">${yen(l.price * l.qty)}</span>
          </li>`).join('')}</ul>` : '<p class="empty">商品をタップすると、ここに追加されます。同じボタンをもう一度タップすると数が増えます。</p>'}
        ${t.qty && t.total === 0 ? '<p class="free-note">チケット特典のみ。お支払いはありません。</p>' : ''}
        ${inline && t.total > 0 ? payHtml(t) : ''}
      </div>
      <div class="pay-bar">
        <div class="total"><small data-total-sub></small><b class="yen" data-total></b></div>
        <button type="button" class="go" data-go="${inline || !t.total ? 'checkout' : 'pay'}"></button>
      </div>`);
    const sheet = $('#paySheet');
    sheet.hidden = !(payOpen && !inline);
    setHtml(sheet, sheet.hidden ? '' : `
      <div class="pay-panel" role="dialog" aria-modal="true" aria-label="お会計">
        <div class="card-head"><h2>お会計 ・ ${t.qty}点</h2><button type="button" class="link" data-act="pay-close">注文に戻る</button></div>
        <div class="pay-total"><span>合計</span><b class="yen" data-total></b></div>
        ${payHtml(t)}
        <button type="button" class="go wide" data-go="checkout"></button>
      </div>`);
  }
  updateChange(t);
  $$('#menu .tile').forEach((b) => {
    const q = ui.cart[b.dataset.item] || 0;
    b.classList.toggle('on', q > 0);
    const badge = $('.badge', b);
    badge.hidden = !q;
    badge.textContent = q;
  });
}
function payHtml(t) {
  const cash = ui.method === 'cash';
  const opts = tenderOptions(t.total);
  return `<div class="pay">
    <div class="seg" role="group" aria-label="支払い方法">
      <button type="button" data-method="cash" aria-pressed="${cash}">現金</button>
      <button type="button" data-method="cashless" aria-pressed="${!cash}">キャッシュレス</button>
    </div>
    ${cash ? `
      <div class="label">お預かり</div>
      <div class="quick">
        <button type="button" data-tender="${t.total}" aria-pressed="${ui.tendered === t.total && !ui.tenderedText}">ちょうど</button>
        ${opts.map((v) => `<button type="button" data-tender="${v}" aria-pressed="${ui.tendered === v && !ui.tenderedText}">${yen(v)}</button>`).join('')}
      </div>
      <label class="field"><span>¥</span><input id="tenderInput" type="text" inputmode="numeric" autocomplete="off" placeholder="その他の金額" value="${esc(ui.tenderedText)}"></label>
      <div class="change" id="changeRow"></div>` : '<p class="fine" style="margin:0">PayPay などで受け取ったら会計してください。</p>'}
  </div>`;
}
function tile(i) {
  return `<button type="button" class="tile" data-item="${esc(i.id)}"
      aria-label="${esc(GROUPS[i.group].label)} ${esc(itemLabel(i))} ${i.price}円を追加">
    <span class="tile-name">${esc(i.name)}</span>
    ${i.option ? `<span class="opt">＋${esc(i.option)}</span>` : ''}
    <span class="tile-price">${yen(i.price)}${i.listPrice > i.price ? `<s>${yen(i.listPrice)}</s>` : ''}</span>
    <span class="badge" hidden></span>
  </button>`;
}
function updateChange(t) {
  const cash = ui.method === 'cash' && t.total > 0;
  const changeVal = cash && ui.tendered != null ? ui.tendered - t.total : null;
  const short = changeVal != null && changeVal < 0;
  const row = $('#changeRow');
  if (row) {
    row.className = 'change' + (changeVal == null ? ' idle' : short ? ' short' : '');
    row.innerHTML = changeVal == null
      ? '<span>お釣り</span><b>お預かりを選ぶと表示します</b>'
      : short ? `<span>あと</span><b class="yen">${yen(-changeVal)}</b>` : `<span>お釣り</span><b class="yen">${yen(changeVal)}</b>`;
  }
  $$('[data-total]').forEach((el) => { el.textContent = yen(t.total); });
  $$('[data-total-sub]').forEach((el) => { el.textContent = t.qty ? `${t.qty}点${t.listTotal > t.total ? ` ・ 特典 −${yen(t.listTotal - t.total)}` : ''}` : '合計'; });
  $$('[data-go]').forEach((go) => {
    const toSheet = go.dataset.go === 'pay';
    go.disabled = !t.qty || (!toSheet && short);
    go.textContent = !t.qty ? '会計' : toSheet ? `お会計へ` : short ? '金額が足りません'
      : t.total === 0 ? '記録する' : ui.method === 'cashless' ? 'キャッシュレスで会計' : changeVal != null ? `会計する（お釣り ${yen(changeVal)}）` : '会計する';
  });
}

function showDone(order) {
  const el = $('#done');
  const handoff = order.lines.map((l) => `<span>${esc(itemLabel(l))} × ${l.qty}</span>`).join('');
  const cash = order.method === 'cash' && order.change != null;
  el.innerHTML = `
    <div class="k" id="doneTitle">${cash ? 'お釣り' : order.method === 'free' ? 'チケット特典' : order.method === 'cashless' ? 'キャッシュレス' : 'お会計'}</div>
    <div class="big yen ${cash && order.change === 0 ? 'zero' : ''}">${cash ? yen(order.change) : yen(order.total)}</div>
    <div class="sub">${cash ? `${yen(order.tendered)} お預かり ・ 合計 ${yen(order.total)}` : `合計 ${order.qty}点`}</div>
    <div class="k">お渡しするもの</div>
    <div class="handoff">${handoff}</div>
    <div class="acts">
      <button type="button" class="btn big danger" data-act="undo">取り消す</button>
      <button type="button" class="btn primary big" data-act="next">次のお客様</button>
    </div>`;
  el.dataset.order = order.id;
  el.hidden = false;
  $('[data-act="next"]', el).focus();
}

// ---- history --------------------------------------------------------------------
function dayChips(sel, current, allLabel) {
  const days = [...new Set(orders().map((o) => o.day))].sort().reverse();
  const today = bizDay(Date.now());
  if (!days.includes(today)) days.unshift(today);
  const chips = days.map((d) => ({ v: d, l: d === today ? `今日 ${dayLabel(d)}` : dayLabel(d) }));
  if (allLabel) chips.push({ v: 'all', l: allLabel });
  setHtml($(sel), chips.map((c) => `<button type="button" data-day="${c.v}" aria-pressed="${c.v === current}">${esc(c.l)}</button>`).join(''));
}
function renderHistory() {
  if (!ui.historyDay) ui.historyDay = bizDay(Date.now());
  dayChips('#historyDays', ui.historyDay, 'すべて');
  const q = ui.historyQuery.trim().replace(/[¥,円\s]/g, '');
  let list = orders().filter((o) => ui.historyDay === 'all' || o.day === ui.historyDay);
  if (q) list = list.filter((o) => String(o.total).includes(q) || o.lines.some((l) => itemLabel(l).includes(q)) || (o.device || '').includes(q));
  if (!list.length) { setHtml($('#historyList'), '<p class="empty">この日の会計はまだありません。</p>'); return; }
  const byDay = {};
  for (const o of list) (byDay[o.day] ||= []).push(o);
  setHtml($('#historyList'), Object.entries(byDay).map(([day, os]) => {
    const live = os.filter((o) => !o.voided);
    return `<div class="day"><span>${dayLabel(day)} ・ ${live.length}件</span><b class="num">${yen(live.reduce((a, o) => a + o.total, 0))}</b></div>
      <ul class="orders">${os.map(orderRow).join('')}</ul>`;
  }).join(''));
}
function orderRow(o) {
  const open = ui.openOrder === o.id;
  return `<li class="order ${o.voided ? 'void' : ''}">
    <button type="button" data-order="${esc(o.id)}" aria-expanded="${open}">
      <time>${hm(o.ts)}</time>
      <span class="items">${o.lines.map((l) => `<span>${l.group === 'ticket' ? '<span class="tag ticket">チケット</span> ' : ''}${esc(itemLabel(l))}×${l.qty}</span>`).join('')}
        ${o.voided ? `<span class="flag">取消${o.voidReason ? '：' + esc(o.voidReason) : ''}</span>` : ''}${o.pending ? '<span class="flag wait">未送信</span>' : ''}</span>
      <span class="amt">${yen(o.total)}<small><span class="m ${o.method}">${METHODS[o.method] || ''}</span></small></span>
    </button>
    ${open ? `<div class="order-detail">
      ${o.tendered != null ? `<span>お預かり ${yen(o.tendered)} ・ お釣り ${yen(o.change)}</span>` : ''}
      ${o.listTotal > o.total ? `<span>特典 −${yen(o.listTotal - o.total)}</span>` : ''}
      <span>${esc(o.device || '端末名なし')}</span>
      ${o.voided ? `<button type="button" class="btn sm" data-unvoid="${esc(o.id)}">取消を戻す</button>` : `<button type="button" class="btn sm danger" data-void="${esc(o.id)}">取り消す</button>`}
    </div>` : ''}
  </li>`;
}
async function voidOrder(id) {
  const reason = await ask({
    title: 'この会計を取り消しますか？',
    body: '集計から外れます。あとで戻すこともできます。',
    choices: VOID_REASONS, ok: '取り消す', danger: true
  });
  if (reason == null) return;
  commit({ type: 'void', id, voided: true, reason, at: Date.now() });
  toast('会計を取り消しました');
}

// ---- stats ----------------------------------------------------------------------
function tally(list) {
  const t = { sales: 0, list: 0, count: list.length, qty: 0, ticketQty: 0, byItem: {}, byMethod: { cash: 0, cashless: 0, free: 0 }, byMethodN: { cash: 0, cashless: 0, free: 0 }, hours: {} };
  for (const o of list) {
    t.sales += o.total; t.list += o.listTotal; t.qty += o.qty;
    t.byMethod[o.method] = (t.byMethod[o.method] || 0) + o.total;
    t.byMethodN[o.method] = (t.byMethodN[o.method] || 0) + 1;
    const h = new Date(o.ts).getHours();
    const hh = (t.hours[h] ||= { regular: 0, ticket: 0 });
    for (const l of o.lines) {
      const key = l.group + '|' + itemLabel(l) + '|' + l.price;
      const r = (t.byItem[key] ||= { group: l.group, label: itemLabel(l), price: l.price, qty: 0, amt: 0, free: 0 });
      r.qty += l.qty; r.amt += l.price * l.qty; r.free += (l.listPrice - l.price) * l.qty;
      hh[l.group === 'ticket' ? 'ticket' : 'regular'] += l.qty;
      if (l.group === 'ticket') t.ticketQty += l.qty;
    }
  }
  return t;
}
function renderStats() {
  if (!ui.statsDay) ui.statsDay = bizDay(Date.now());
  dayChips('#statsDays', ui.statsDay, '全期間');
  const list = liveOrders().filter((o) => ui.statsDay === 'all' || o.day === ui.statsDay);
  const voided = orders().filter((o) => o.voided && (ui.statsDay === 'all' || o.day === ui.statsDay)).length;
  const t = tally(list);
  const paidCount = t.byMethodN.cash + t.byMethodN.cashless;
  const avg = paidCount ? Math.round(t.sales / paidCount) : 0;

  const hours = Object.keys(t.hours).map(Number);
  // 深夜 0〜5 時は前日の続きなので、24〜29 時として並べる
  const order = (h) => (h < DAY_CUTOFF_HOURS ? h + 24 : h);
  let hoursHtml = '<p class="empty">まだ会計がありません。</p>';
  if (hours.length && ui.statsDay !== 'all') {
    const lo = Math.min(...hours.map(order)), hi = Math.max(...hours.map(order));
    const max = Math.max(...hours.map((h) => t.hours[h].regular + t.hours[h].ticket));
    const cols = [];
    for (let x = lo; x <= hi; x++) {
      const v = t.hours[x % 24] || { regular: 0, ticket: 0 };
      const sum = v.regular + v.ticket;
      cols.push(`<div class="h" title="${x % 24}時台 ${sum}点"><b>${sum || ''}</b>
        <i style="height:${(v.regular / max) * 100}%"></i>${v.ticket ? `<i class="t" style="height:${(v.ticket / max) * 100}%"></i>` : ''}<em>${x % 24}</em></div>`);
    }
    hoursHtml = `<div class="hours">${cols.join('')}</div><div class="legend"><span><i class="dot p"></i>通常</span><span><i class="dot t"></i>チケット</span></div>`;
  } else if (ui.statsDay === 'all') {
    const days = {};
    for (const o of list) days[o.day] = (days[o.day] || 0) + o.total;
    const ds = Object.keys(days).sort();
    const max = Math.max(1, ...Object.values(days));
    hoursHtml = ds.length ? `<div class="bars">${ds.map((d) => `<div class="bar-row"><span>${dayLabel(d)}</span><span class="track"><i style="width:${(days[d] / max) * 100}%"></i></span><b>${yen(days[d])}</b></div>`).join('')}</div>` : hoursHtml;
  }
  const mMax = Math.max(1, t.byMethod.cash, t.byMethod.cashless);
  const rows = Object.values(t.byItem).sort((a, b) => (a.group === b.group ? 0 : a.group === 'regular' ? -1 : 1) || b.qty - a.qty);
  const grp = (g) => rows.filter((r) => r.group === g);
  const sub = (rs) => ({ qty: rs.reduce((a, r) => a + r.qty, 0), amt: rs.reduce((a, r) => a + r.amt, 0), free: rs.reduce((a, r) => a + r.free, 0) });

  setHtml($('#statsBody'), `
    <div class="kpis">
      <div class="kpi hero"><span>売上</span><b class="yen">${yen(t.sales)}</b><small>会計 ${t.count}件${voided ? ` ・ 取消 ${voided}件` : ''}</small></div>
      <div class="kpi"><span>出た数</span><b class="yen">${t.qty}<small style="font-size:.45em"> 点</small></b><small>うちチケット ${t.ticketQty}点</small></div>
      <div class="kpi"><span>客単価</span><b class="yen">${yen(avg)}</b><small>有料の会計 ${paidCount}件</small></div>
      <div class="kpi"><span>チケット特典</span><b class="yen">${yen(t.list - t.sales)}</b><small>無料にした額</small></div>
    </div>
    <div class="grid2">
      <div class="card"><div class="card-head"><h3>${ui.statsDay === 'all' ? '日別の売上' : '時間帯別の数'}</h3></div>${hoursHtml}</div>
      <div class="card"><div class="card-head"><h3>支払い方法</h3></div>
        <div class="bars">
          <div class="bar-row"><span>現金</span><span class="track"><i style="width:${(t.byMethod.cash / mMax) * 100}%"></i></span><b>${yen(t.byMethod.cash)}</b></div>
          <div class="bar-row"><span>キャッシュレス</span><span class="track"><i class="c" style="width:${(t.byMethod.cashless / mMax) * 100}%"></i></span><b>${yen(t.byMethod.cashless)}</b></div>
          <div class="bar-row"><span>無料</span><span class="track"><i class="t" style="width:${t.byMethodN.free ? 100 : 0}%"></i></span><b>${t.byMethodN.free}件</b></div>
        </div>
        <p class="fine">現金 ${t.byMethodN.cash}件 ・ キャッシュレス ${t.byMethodN.cashless}件 ・ チケット特典のみ ${t.byMethodN.free}件</p>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>商品別</h3></div>
      <div class="scroll-x"><table>
        <thead><tr><th>商品</th><th>数</th><th>売上</th><th>特典</th></tr></thead>
        <tbody>${['regular', 'ticket'].map((g) => grp(g).length ? `<tr class="grp ${g}"><td colspan="4">${GROUPS[g].label}</td></tr>` +
          grp(g).map((r) => `<tr><td>${esc(r.label)} <span class="fine">${yen(r.price)}</span></td><td>${r.qty}</td><td>${yen(r.amt)}</td><td>${r.free ? '−' + yen(r.free) : '—'}</td></tr>`).join('') : '').join('') ||
          '<tr><td colspan="4" class="empty">まだ会計がありません。</td></tr>'}</tbody>
        <tfoot><tr><td>合計</td><td>${sub(rows).qty}</td><td>${yen(sub(rows).amt)}</td><td>${sub(rows).free ? '−' + yen(sub(rows).free) : '—'}</td></tr></tfoot>
      </table></div>
      <div class="acts" style="margin-top:14px">
        <button type="button" class="btn" data-act="copy-stats">集計をコピー</button>
        <button type="button" class="btn" data-act="csv">CSVで保存</button>
      </div>
      <p class="fine">営業日は朝${DAY_CUTOFF_HOURS}時で区切っています（深夜0〜${DAY_CUTOFF_HOURS}時の会計は前日分）。取り消した会計は含みません。</p>
    </div>`);
}
function statsText() {
  const list = liveOrders().filter((o) => ui.statsDay === 'all' || o.day === ui.statsDay);
  const t = tally(list);
  const head = ui.statsDay === 'all' ? '全期間' : dayLabel(ui.statsDay);
  return [`DOPE ${head} の売上`, `売上 ${yen(t.sales)}（会計 ${t.count}件）`, `現金 ${yen(t.byMethod.cash)} ／ キャッシュレス ${yen(t.byMethod.cashless)}`,
    `出た数 ${t.qty}点（うちチケット ${t.ticketQty}点）`, `チケット特典 ${yen(t.list - t.sales)}`, '',
    ...Object.values(t.byItem).map((r) => `${GROUPS[r.group].label} ${r.label}: ${r.qty}点 ${yen(r.amt)}`)].join('\n');
}
function downloadCsv() {
  const list = orders().filter((o) => ui.statsDay === 'all' || o.day === ui.statsDay).slice().reverse();
  const rows = [['営業日', '日時', '会計ID', '区分', '商品', '単価', '定価', '数', '小計', '支払い', 'お預かり', 'お釣り', '端末', '取消', '取消理由']];
  for (const o of list) for (const l of o.lines) {
    rows.push([o.day, new Date(o.ts).toLocaleString('ja-JP'), o.id, GROUPS[l.group]?.label || l.group, itemLabel(l), l.price, l.listPrice, l.qty, l.price * l.qty,
      METHODS[o.method] || o.method, o.tendered ?? '', o.change ?? '', o.device || '', o.voided ? '取消' : '', o.voidReason || '']);
  }
  const csv = '﻿' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `dope-sales-${ui.statsDay}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- close (レジ開け・締め) ------------------------------------------------------
function shiftCash(s) {
  return liveOrders().filter((o) => o.shiftId === s.id && o.method === 'cash').reduce((a, o) => a + o.total, 0);
}
function shiftSummary(s) {
  const list = liveOrders().filter((o) => o.shiftId === s.id);
  return { count: list.length, sales: list.reduce((a, o) => a + o.total, 0), cash: shiftCash(s), cashless: list.filter((o) => o.method === 'cashless').reduce((a, o) => a + o.total, 0) };
}
function countedTotal() { return DENOMS.reduce((a, d) => a + d * (ui.counts[d] || 0), 0); }
function renderClose() {
  const s = openShift();
  const past = shifts().filter((x) => x.closedAt).slice(0, 20);
  const pastHtml = past.length ? `<ul class="shift-list">${past.map((x) => {
    const diff = (x.counted ?? 0) - (x.expected ?? 0);
    return `<li><span><b class="d">${mdhm(x.openedAt)} 〜 ${hm(x.closedAt)}</b><br><span class="fine">準備金 ${yen(x.float)} ・ 数えた現金 ${yen(x.counted)}${x.note ? ' ・ ' + esc(x.note) : ''}</span></span>
      <b class="num" style="color:var(${diff === 0 ? '--ok' : diff > 0 ? '--warn' : '--bad'})">${diff === 0 ? '過不足なし' : (diff > 0 ? '+' : '−') + yen(Math.abs(diff))}</b></li>`;
  }).join('')}</ul>` : '<p class="empty">まだ締めた記録はありません。</p>';

  if (!s) {
    setHtml($('#closeBody'), `<div class="close-grid">
      <div class="card"><div class="card-head"><h2>レジ開け</h2></div>
        <form class="form" id="openForm">
          <p class="fine" style="margin:0">営業を始める前に、釣り銭として入れた現金（準備金）を記録します。締めのときに「準備金＋現金の売上」と実際の現金を比べます。</p>
          <label class="l">準備金<span class="field"><span>¥</span><input name="float" inputmode="numeric" autocomplete="off" placeholder="例: 20000" required></span></label>
          <div class="quick">${[10000, 20000, 30000, 50000].map((v) => `<button type="button" data-float="${v}">${yen(v)}</button>`).join('')}</div>
          <button class="btn primary big" type="submit">レジを開ける</button>
        </form>
      </div>
      <div class="card"><div class="card-head"><h2>これまでの締め</h2></div>${pastHtml}</div>
    </div>`);
    return;
  }
  const sum = shiftSummary(s);
  const expected = s.float + sum.cash;
  const counted = countedTotal();
  const diff = counted - expected;
  const anyCount = DENOMS.some((d) => ui.counts[d]);
  setHtml($('#closeBody'), `<div class="close-grid">
    <div class="card">
      <div class="card-head"><h2>営業中</h2><span class="fine" style="margin:0">${mdhm(s.openedAt)} から${s.openedBy ? ' ・ ' + esc(s.openedBy) : ''}</span></div>
      <div class="facts">
        <div class="fact"><span>準備金</span><b>${yen(s.float)}</b></div>
        <div class="fact"><span>現金の売上</span><b>${yen(sum.cash)}</b></div>
        <div class="fact"><span>キャッシュレス</span><b>${yen(sum.cashless)}</b></div>
        <div class="fact"><span>会計</span><b>${sum.count}件</b></div>
      </div>
      <div class="diff" style="margin-top:10px"><span>レジにあるはずの現金</span><b class="yen">${yen(expected)}</b></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>現金を数える</h2>${anyCount ? '<button type="button" class="link" data-act="reset-count">クリア</button>' : ''}</div>
      <div class="denoms">${DENOMS.map((d) => `
        <div class="denom"><label for="c${d}">${yen(d)}</label>
          <span class="stepper"><button type="button" data-count="${d}" data-d="-1" aria-label="${d}円を1枚減らす">−</button>
            <input id="c${d}" data-countin="${d}" inputmode="numeric" autocomplete="off" value="${ui.counts[d] || ''}" placeholder="0">
            <button type="button" data-count="${d}" data-d="1" aria-label="${d}円を1枚増やす">＋</button></span>
          <output id="o${d}">${yen(d * (ui.counts[d] || 0))}</output></div>`).join('')}
      </div>
      <div class="diff ${!anyCount ? '' : diff === 0 ? 'ok' : diff > 0 ? 'over' : 'short'}" id="countDiff" style="margin-top:12px"></div>
      <button type="button" class="btn primary big" style="width:100%;margin-top:12px" data-act="close-shift" ${anyCount ? '' : 'disabled'}>この金額でレジを締める</button>
    </div>
    <div class="card"><div class="card-head"><h2>これまでの締め</h2></div>${pastHtml}</div>
  </div>`);
  updateCountDiff();
}
function updateCountDiff() {
  const s = openShift();
  if (!s) return;
  const expected = s.float + shiftCash(s);
  const counted = countedTotal();
  const diff = counted - expected;
  const any = DENOMS.some((d) => ui.counts[d]);
  const el = $('#countDiff');
  el.className = 'diff ' + (!any ? '' : diff === 0 ? 'ok' : diff > 0 ? 'over' : 'short');
  el.innerHTML = `<span>数えた現金 ${yen(counted)}<br><span class="fine">${!any ? '枚数を入れてください' : diff === 0 ? 'ぴったりです' : diff > 0 ? '多い' : '足りない'}</span></span><b class="yen">${!any ? '—' : diff === 0 ? '±0' : (diff > 0 ? '+' : '−') + yen(Math.abs(diff))}</b>`;
  for (const d of DENOMS) { const o = $('#o' + d); if (o) o.textContent = yen(d * (ui.counts[d] || 0)); }
  const btn = $('[data-act="close-shift"]');
  if (btn) btn.disabled = !any;
}
async function closeShift() {
  const s = openShift();
  const expected = s.float + shiftCash(s);
  const counted = countedTotal();
  const diff = counted - expected;
  const note = await ask({
    title: 'レジを締めますか？',
    body: `数えた現金 ${yen(counted)} ／ あるはずの現金 ${yen(expected)}（${diff === 0 ? '過不足なし' : (diff > 0 ? '+' : '−') + yen(Math.abs(diff))}）`,
    input: diff !== 0 ? '過不足の理由（わかれば）' : 'メモ（任意）', ok: '締める'
  });
  if (note == null) return;
  const counts = {};
  for (const d of DENOMS) if (ui.counts[d]) counts[d] = ui.counts[d];
  commit({ type: 'shift', shift: { ...s, closedAt: Date.now(), closedBy: device, counts, counted, expected, note } });
  ui.counts = {};
  toast('レジを締めました');
}

// ---- theme ----------------------------------------------------------------------
const THEMES = { auto: '端末に合わせる', light: 'ライト', dark: 'ダーク' };
let theme = lsGet(LS.theme, 'auto');
const DARK_MQ = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  const dark = theme === 'dark' || (theme === 'auto' && DARK_MQ.matches);
  $('meta[name="theme-color"]').content = dark ? '#0E0E10' : '#F5F5F7';
}
DARK_MQ.addEventListener('change', applyTheme);
applyTheme();

// ---- settings -------------------------------------------------------------------
function renderSettings() {
  const list = items();
  setHtml($('#settingsBody'), `<div class="set-grid">
    <div class="card">
      <div class="card-head"><h2>商品</h2><button type="button" class="btn sm" data-act="add-item">＋ 商品を追加</button></div>
      <div class="item-rows">${list.map((i, n) => `
        <div class="item-row ${i.active ? '' : 'off'}">
          <div><div class="nm">${i.group === 'ticket' ? '<span class="tag">チケット</span>' : ''}${esc(i.name)}${i.option ? `<span class="opt">＋${esc(i.option)}</span>` : ''}</div>
            <div class="pr">${yen(i.price)}${i.listPrice > i.price ? `（定価 ${yen(i.listPrice)}）` : ''}${i.active ? '' : ' ・ 非表示'}</div></div>
          <div class="ops">
            <button type="button" class="icon-btn" data-move="${esc(i.id)}" data-d="-1" ${n === 0 ? 'disabled' : ''} aria-label="上へ">↑</button>
            <button type="button" class="icon-btn" data-move="${esc(i.id)}" data-d="1" ${n === list.length - 1 ? 'disabled' : ''} aria-label="下へ">↓</button>
            <button type="button" class="btn sm" data-edit="${esc(i.id)}">編集</button>
          </div>
        </div>`).join('') || '<p class="empty">商品がありません。</p>'}
      </div>
      <p class="fine">値段を変えても、これまでの会計の金額は変わりません。チケット購入者向けの商品は「定価」を入れると、割り引いた額が集計に出ます。</p>
    </div>
    <div class="card">
      <div class="card-head"><h2>この端末</h2></div>
      <div class="label" style="margin-bottom:6px">画面の色</div>
      <div class="seg" role="group" aria-label="画面の色" style="margin-bottom:16px">${Object.entries(THEMES).map(([k, l]) => `<button type="button" data-theme="${k}" aria-pressed="${theme === k}">${l}</button>`).join('')}</div>
      <form class="form" id="deviceForm">
        <label class="l">端末の名前<span class="field"><input name="device" value="${esc(device)}" placeholder="例: 受付iPad" maxlength="30"></span></label>
        <button class="btn" type="submit">保存</button>
      </form>
      <p class="fine">履歴とレジ締めに、どの端末で記録したかが出ます。</p>
      <hr style="border:0;border-top:1px solid var(--line);margin:16px 0">
      <div class="facts">
        <div class="fact"><span>送信待ち</span><b>${outbox.length}件</b></div>
        <div class="fact"><span>最後に同期</span><b>${ui.sync.last ? hm(ui.sync.last) : '—'}</b></div>
      </div>
      <div class="acts" style="margin-top:12px">
        <button type="button" class="btn" data-act="sync-now">今すぐ同期</button>
        <button type="button" class="btn" data-act="passcode">パスコード</button>
      </div>
      <p class="fine">電波がない間の会計は、この端末に「送信待ち」として残り、つながると自動で送られます。送信待ちがある間は、この端末のデータを消さないでください。</p>
    </div>
  </div>`);
}
async function editItem(id) {
  const cur = id ? db.items[id] : { id: uid('i'), name: 'ドリンク', option: '', price: 300, listPrice: 300, group: 'regular', sort: (items().at(-1)?.sort || 0) + 10, active: true };
  const r = await ask({
    title: id ? '商品を編集' : '商品を追加',
    form: `
      <label class="l">名前<span class="field"><input name="name" value="${esc(cur.name)}" maxlength="40" required></span></label>
      <label class="l">オプション（例: バニラアイス・空欄可）<span class="field"><input name="option" value="${esc(cur.option)}" maxlength="40"></span></label>
      <div class="row2">
        <label class="l">値段<span class="field"><span>¥</span><input name="price" inputmode="numeric" value="${cur.price}" required></span></label>
        <label class="l">定価（割引前）<span class="field"><span>¥</span><input name="listPrice" inputmode="numeric" value="${cur.listPrice}"></span></label>
      </div>
      <label class="l">区分<span class="field"><select name="group"><option value="regular" ${cur.group === 'regular' ? 'selected' : ''}>通常</option><option value="ticket" ${cur.group === 'ticket' ? 'selected' : ''}>ライブチケット購入者</option></select></span></label>
      <label class="check"><input type="checkbox" name="active" ${cur.active ? 'checked' : ''}> レジに表示する</label>`,
    ok: '保存', extra: id ? { label: '削除', value: '__delete' } : null
  });
  if (r == null) return;
  if (r === '__delete') {
    const yes = await ask({ title: `「${itemLabel(cur)}」を削除しますか？`, body: 'これまでの会計の記録は残ります。', ok: '削除', danger: true });
    if (yes == null) return;
    commit({ type: 'item', item: { ...cur, deleted: true, active: false } });
    return;
  }
  const n = (v) => Math.max(0, Math.floor(Number(String(v).replace(/[^\d]/g, '')) || 0));
  const price = n(r.price);
  commit({ type: 'item', item: { ...cur, name: r.name.trim() || '商品', option: r.option.trim(), price, listPrice: Math.max(price, n(r.listPrice || price)), group: r.group, active: !!r.active } });
}
function moveItem(id, d) {
  const list = items();
  const i = list.findIndex((x) => x.id === id);
  const j = i + d;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  list.forEach((x, k) => { if (x.sort !== (k + 1) * 10) commit({ type: 'item', item: { ...x, sort: (k + 1) * 10 } }); });
}
async function askPasscode() {
  if ($('#sheet').open) return;
  const r = await ask({ title: 'パスコード', body: 'このレジにはパスコードが設定されています。スタッフに聞いて入力してください。', input: 'パスコード', value: passcode, ok: '保存' });
  if (r == null) return;
  passcode = r.trim();
  lsSet(LS.pass, passcode);
  sync();
}

// ---- assistant ------------------------------------------------------------------
// 会話は端末に保存し、毎回テキストだけをサーバーに送る。データを変える操作は「提案」で返ってくるので、
// スタッフが「実行」を押したときだけ、通常の操作（commit）として記録する。
const AI_SUGGEST = ['今日の売上は？', 'いちばん出ている時間帯は？', 'ドリンク2つとアイス付き1つ', 'レジ締めを手伝って', 'さっきの会計を取り消したい'];
const ai = { msgs: lsGet(LS.ai, []), busy: false, usage: null, rec: null };
const saveAI = () => lsSet(LS.ai, ai.msgs.slice(-60));

async function enterAI() {
  renderAI();
  try {
    const r = await fetch(API + '/ai/usage', { method: 'POST', headers: { 'content-type': 'application/json', 'x-passcode': passcode }, body: '{}' });
    if (r.ok) ai.usage = await r.json();
  } catch { /* オフライン */ }
  renderAI();
  if (!compact()) $('#prompt').focus();
}
function aiMeta() {
  const u = ai.usage;
  if (!u) return '';
  if (!u.enabled) return 'API キー未設定';
  return `今日 ${u.todayRequests} / ${u.dailyLimit} 回`;
}
function md(text) {
  // 太字と箇条書きだけ扱う。HTML は必ずエスケープしてから整形する。
  const lines = esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').split('\n');
  let html = '', list = false;
  for (const ln of lines) {
    const m = ln.match(/^\s*[-・*]\s+(.*)/);
    if (m) { if (!list) { html += '<ul>'; list = true; } html += `<li>${m[1]}</li>`; continue; }
    if (list) { html += '</ul>'; list = false; }
    if (ln.trim()) html += `<p>${ln}</p>`;
  }
  return html + (list ? '</ul>' : '');
}
function proposalText(a) {
  if (a.type === 'void') return { t: a.voided ? '会計を取り消す' : '取消を戻す', d: `${a.summary}${a.voided ? ` ・ 理由: ${a.reason}` : ''}`, ok: a.voided ? '取り消す' : '戻す', danger: a.voided };
  if (a.type === 'item') {
    const it = a.item, b = a.before;
    const now = `${itemLabel(it)} ${yen(it.price)}${it.listPrice > it.price ? `（定価 ${yen(it.listPrice)}）` : ''}${it.group === 'ticket' ? ' ・ チケット' : ''}${it.active ? '' : ' ・ 非表示'}`;
    if (it.deleted) return { t: '商品を削除', d: b ? itemLabel(b) : now, ok: '削除', danger: true };
    return { t: b ? '商品を変更' : '商品を追加', d: b ? `${itemLabel(b)} ${yen(b.price)} → ${now}` : now, ok: b ? '変更する' : '追加する' };
  }
  if (a.type === 'open_shift') return { t: 'レジを開ける', d: `準備金 ${yen(a.float)}`, ok: '開ける' };
  if (a.type === 'close_shift') {
    const s = openShift();
    const counted = a.counts ? DENOMS.reduce((x, d) => x + d * (a.counts[d] || 0), 0) : a.counted || 0;
    const exp = s ? s.float + shiftCash(s) : 0;
    const diff = counted - exp;
    return { t: 'レジを締める', d: s ? `数えた現金 ${yen(counted)} ／ あるはず ${yen(exp)}（${diff === 0 ? '過不足なし' : (diff > 0 ? '+' : '−') + yen(Math.abs(diff))}）` : '営業中のレジがありません', ok: '締める', disabled: !s };
  }
  return { t: a.type, d: '', ok: '実行' };
}
function renderAI() {
  if (ui.view !== 'ai') return;
  $('#aiMeta').textContent = aiMeta();
  const off = ai.usage && !ai.usage.enabled;
  const empty = !ai.msgs.length;
  const html = (off ? `<div class="ai-off"><b>アシスタントはまだ使えません。</b><p class="fine">Gemini の API キーを Worker に登録してください:<br><code>npx wrangler secret put GEMINI_API_KEY --name dope-register</code></p></div>` : '') +
    (empty ? `<p class="empty">売上の確認、注文の入力、取消やレジ締めの準備などを頼めます。データを変える操作は、確認ボタンを押すまで実行しません。</p>
      <div class="suggest">${AI_SUGGEST.map((q) => `<button type="button" data-ask="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : '') +
    ai.msgs.map((m, i) => m.role === 'user'
      ? `<div class="msg user">${esc(m.content)}</div>`
      : `<div class="msg bot">${m.error ? `<p class="err">${esc(m.error)}</p>` : md(m.content)}
          ${(m.actions || []).map((a, j) => {
            if (a.type === 'set_cart') return `<span class="applied">カートに入れました（${a.lines.reduce((x, l) => x + l.qty, 0)}点）</span>`;
            if (a.type === 'navigate') return '';
            const p = proposalText(a);
            return `<div class="proposal"><span class="t">${esc(p.t)}</span><span class="d">${esc(p.d)}</span>
              ${a.state === 'done' ? '<span class="s ok">実行しました</span>' : a.state === 'no' ? '<span class="s no">やめました</span>' :
              `<div class="acts"><button type="button" class="btn sm ${p.danger ? 'danger' : 'primary'}" data-ai-ok="${i}:${j}" ${p.disabled ? 'disabled' : ''}>${esc(p.ok)}</button><button type="button" class="btn sm" data-ai-no="${i}:${j}">やめる</button></div>`}
            </div>`;
          }).join('')}</div>`).join('') +
    (ai.busy ? '<div class="msg bot"><span class="typing" aria-label="考えています"><i></i><i></i><i></i></span></div>' : '') +
    (!empty && !ai.busy ? '<div><button type="button" class="link" data-act="ai-reset">新しい会話にする</button></div>' : '');
  setHtml($('#thread'), html);
  $('#send').disabled = ai.busy || !$('#prompt').value.trim();
}
async function askAI(text) {
  text = text.trim();
  if (!text || ai.busy) return;
  ai.msgs.push({ role: 'user', content: text });
  ai.busy = true;
  $('#prompt').value = '';
  autosize();
  renderAI();
  window.scrollTo(0, document.body.scrollHeight);
  const history = ai.msgs.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content })).slice(-16);
  const cart = cartLines().map((l) => ({ item: itemLabel(l), group: l.group, qty: l.qty }));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  let reply;
  try {
    const r = await fetch(API + '/ai', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-passcode': passcode },
      body: JSON.stringify({ messages: history, context: { view: 'ai', device, pending: outbox.length, cart } })
    });
    if (r.status === 401) { askPasscode(); throw new Error('パスコードが必要です'); }
    const data = await r.json();
    reply = data.ok ? { role: 'assistant', content: data.text || '', actions: data.actions || [] }
      : { role: 'assistant', content: '', error: data.message || 'エラーが起きました', actions: data.actions || [] };
  } catch (e) {
    reply = { role: 'assistant', content: '', error: e.name === 'AbortError' ? '時間がかかりすぎたので止めました。もう一度どうぞ。' : navigator.onLine === false ? 'オフラインのため使えません。' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
  ai.busy = false;
  ai.msgs.push(reply);
  saveAI();
  // カートと画面切り替えはすぐ反映する（あとから直しやすい操作なので確認なし）
  let go = null;
  for (const a of reply.actions || []) {
    if (a.type === 'set_cart') {
      ui.cart = {};
      for (const l of a.lines) if (db.items[l.item_id]) ui.cart[l.item_id] = l.qty;
      ui.tendered = null; ui.tenderedText = ''; payOpen = false;
      saveCart();
      go = 'register';
    } else if (a.type === 'navigate') go = a.view;
  }
  enterAIUsageLater();
  if (go && go !== 'ai') { toast(reply.content ? reply.content.split('\n')[0].slice(0, 60) : '画面を切り替えました'); location.hash = '#' + go; }
  else renderAI();
  window.scrollTo(0, document.body.scrollHeight);
}
function enterAIUsageLater() {
  fetch(API + '/ai/usage', { method: 'POST', headers: { 'content-type': 'application/json', 'x-passcode': passcode }, body: '{}' })
    .then((r) => (r.ok ? r.json() : null)).then((u) => { if (u) { ai.usage = u; renderAI(); } }).catch(() => {});
}
function runProposal(i, j) {
  const a = ai.msgs[i]?.actions?.[j];
  if (!a || a.state) return;
  if (a.type === 'void') {
    commit({ type: 'void', id: a.id, voided: a.voided, reason: a.reason, at: Date.now() });
  } else if (a.type === 'item') {
    const it = { ...a.item };
    if (!it.id) { it.id = uid('i'); it.sort = (items().at(-1)?.sort || 0) + 10; }
    commit({ type: 'item', item: it });
  } else if (a.type === 'open_shift') {
    if (openShift()) return toast('もう営業中です', { bad: true });
    commit({ type: 'shift', shift: { id: uid('s'), openedAt: Date.now(), openedBy: device, float: a.float, closedAt: null } });
  } else if (a.type === 'close_shift') {
    const s = openShift();
    if (!s) return toast('営業中のレジがありません', { bad: true });
    const counts = a.counts || {};
    const counted = a.counts ? DENOMS.reduce((x, d) => x + d * (counts[d] || 0), 0) : a.counted || 0;
    commit({ type: 'shift', shift: { ...s, closedAt: Date.now(), closedBy: device, counts, counted, expected: s.float + shiftCash(s), note: a.note || '' } });
  }
  a.state = 'done';
  saveAI();
  renderAI();
  toast('実行しました');
}
function autosize() {
  const t = $('#prompt');
  t.style.height = 'auto';
  t.style.height = Math.min(160, t.scrollHeight) + 'px';
}
function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;
  const btn = $('#mic');
  btn.hidden = false;
  btn.addEventListener('click', () => {
    if (ai.rec) { ai.rec.stop(); return; }
    const rec = new SR();
    rec.lang = 'ja-JP';
    rec.interimResults = true;
    ai.rec = rec;
    btn.setAttribute('aria-pressed', 'true');
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let k = e.resultIndex; k < e.results.length; k++) {
        if (e.results[k].isFinal) finalText += e.results[k][0].transcript; else interim += e.results[k][0].transcript;
      }
      $('#prompt').value = finalText + interim;
      autosize();
    };
    rec.onend = () => {
      ai.rec = null;
      btn.setAttribute('aria-pressed', 'false');
      if (finalText.trim()) askAI(finalText);
    };
    rec.onerror = () => { ai.rec = null; btn.setAttribute('aria-pressed', 'false'); };
    rec.start();
  });
}

// ---- dialogs / toast ------------------------------------------------------------
function ask({ title, body = '', choices, input, value = '', form, ok = 'OK', danger = false, extra = null }) {
  const dlg = $('#sheet');
  dlg.innerHTML = `<form method="dialog">
    <h2>${esc(title)}</h2>${body ? `<p>${esc(body)}</p>` : ''}
    ${choices ? `<div class="seg" role="radiogroup">${choices.map((c, i) => `<button type="button" data-choice="${esc(c)}" aria-pressed="${i === 0}">${esc(c)}</button>`).join('')}</div>` : ''}
    ${input ? `<label class="l"><span class="sr">${esc(input)}</span><span class="field"><input name="value" value="${esc(value)}" placeholder="${esc(input)}" autocomplete="off"></span></label>` : ''}
    ${form || ''}
    <div class="acts">
      ${extra ? `<button type="button" class="btn danger" data-extra style="margin-right:auto">${esc(extra.label)}</button>` : ''}
      <button type="button" class="btn" data-cancel>やめる</button>
      <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(ok)}</button>
    </div></form>`;
  return new Promise((resolve) => {
    let choice = choices ? choices[0] : null;
    const f = $('form', dlg);
    const finish = (v) => { dlg.close(); resolve(v); };
    dlg.onclick = (e) => {
      const c = e.target.closest('[data-choice]');
      if (c) { choice = c.dataset.choice; $$('[data-choice]', dlg).forEach((b) => b.setAttribute('aria-pressed', b === c)); }
      if (e.target.closest('[data-cancel]')) finish(null);
      if (e.target.closest('[data-extra]')) finish(extra.value);
      if (e.target === dlg) finish(null);
    };
    dlg.oncancel = (e) => { e.preventDefault(); finish(null); };
    f.onsubmit = (e) => {
      e.preventDefault();
      if (form) {
        const fd = new FormData(f);
        const o = Object.fromEntries(fd.entries());
        $$('input[type=checkbox]', f).forEach((c) => { o[c.name] = c.checked; });
        return finish(o);
      }
      finish(input ? $('input[name=value]', f).value : choice ?? true);
    };
    dlg.showModal();
    const first = $('input', f);
    if (first && (input || form)) first.focus();
  });
}
function toast(msg, { action, onAction, ms = 3500, bad = false } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  if (action) $('button', el).onclick = () => { el.remove(); onAction(); };
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

// ---- routing & events -----------------------------------------------------------
const VIEWS = ['register', 'history', 'stats', 'close', 'ai', 'settings'];
function route() {
  const v = location.hash.slice(1);
  ui.view = VIEWS.includes(v) ? v : 'register';
  document.body.dataset.view = ui.view;
  for (const x of VIEWS) $('#v-' + x).hidden = x !== ui.view;
  $$('.bar a[data-view]').forEach((a) => (a.dataset.view === ui.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  renderAll();
  if (ui.view === 'settings') renderSettings();
  if (ui.view === 'ai') enterAI();
  window.scrollTo(0, 0);
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('button, a');
  if (!t) return;
  const d = t.dataset;
  if (d.go === 'checkout') return checkout();
  if (d.go === 'pay') { payOpen = true; return renderRegister(); }
  if (d.item) { addToCart(d.item, 1); if (navigator.vibrate) navigator.vibrate(8); return; }
  if (d.step) return addToCart(d.step, Number(d.d));
  if (d.method) { ui.method = d.method; return renderRegister(); }
  if (d.tender) { ui.tendered = Number(d.tender); ui.tenderedText = ''; return renderRegister(); }
  if (d.day) {
    if (ui.view === 'history') { ui.historyDay = d.day; renderHistory(); } else { ui.statsDay = d.day; renderStats(); }
    return;
  }
  if (d.order) { ui.openOrder = ui.openOrder === d.order ? null : d.order; return renderHistory(); }
  if (d.void) return voidOrder(d.void);
  if (d.unvoid) { commit({ type: 'void', id: d.unvoid, voided: false, at: Date.now() }); return toast('取消を戻しました'); }
  if (d.float) { const i = $('#openForm input[name=float]'); i.value = d.float; return; }
  if (d.count) { ui.counts[d.count] = Math.max(0, (ui.counts[d.count] || 0) + Number(d.d)); $('#c' + d.count).value = ui.counts[d.count] || ''; return updateCountDiff(); }
  if (d.theme) { theme = d.theme; lsSet(LS.theme, theme); applyTheme(); return renderSettings(); }
  if (d.ask) return askAI(d.ask);
  if (d.aiOk) { const [i, j] = d.aiOk.split(':').map(Number); return runProposal(i, j); }
  if (d.aiNo) { const [i, j] = d.aiNo.split(':').map(Number); const a = ai.msgs[i]?.actions?.[j]; if (a) { a.state = 'no'; saveAI(); renderAI(); } return; }
  if (d.edit) return editItem(d.edit);
  if (d.move) return moveItem(d.move, Number(d.d));
  switch (d.act) {
    case 'pay': payOpen = true; return renderRegister();
    case 'pay-close': payOpen = false; return renderRegister();
    case 'clear': clearCart(); return renderRegister();
    case 'next': $('#done').hidden = true; return;
    case 'undo': {
      const id = $('#done').dataset.order;
      $('#done').hidden = true;
      const o = db.orders[id];
      if (o) {
        commit({ type: 'void', id, voided: true, reason: '打ち間違い', at: Date.now() });
        // 取り消した会計の中身をカートに戻して、打ち直せるようにする
        ui.cart = {};
        for (const l of o.lines) if (db.items[l.itemId]) ui.cart[l.itemId] = (ui.cart[l.itemId] || 0) + l.qty;
        saveCart();
        renderRegister();
        toast('取り消して、注文を戻しました');
      }
      return;
    }
    case 'copy-stats': {
      const text = statsText();
      return navigator.clipboard?.writeText(text).then(() => toast('集計をコピーしました'), () => ask({ title: '集計', form: `<textarea readonly style="width:100%;min-height:180px;background:var(--bg);border:1px solid var(--line-2);border-radius:10px;padding:10px">${esc(text)}</textarea>`, ok: '閉じる' }));
    }
    case 'csv': return downloadCsv();
    case 'reset-count': ui.counts = {}; return renderClose();
    case 'close-shift': return closeShift();
    case 'add-item': return editItem(null);
    case 'sync-now': return sync();
    case 'ai-reset': ai.msgs = []; saveAI(); return renderAI();
    case 'passcode': return askPasscode();
  }
});
$('#sync').addEventListener('click', () => sync());
$('#paySheet').addEventListener('click', (e) => { if (e.target.id === 'paySheet') { payOpen = false; renderRegister(); } });

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'tenderInput') {
    const digits = t.value.replace(/[^\d]/g, '');
    ui.tenderedText = digits;
    ui.tendered = digits ? Number(digits) : null;
    $$('[data-tender]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    renderRegister();
  } else if (t.id === 'prompt') {
    autosize();
    $('#send').disabled = ai.busy || !t.value.trim();
  } else if (t.id === 'historyQuery') {
    ui.historyQuery = t.value;
    renderHistory();
  } else if (t.dataset.countin) {
    ui.counts[t.dataset.countin] = Math.max(0, Math.floor(Number(t.value.replace(/[^\d]/g, '')) || 0));
    updateCountDiff();
  }
});
document.addEventListener('submit', (e) => {
  const f = e.target;
  if (f.id === 'openForm') {
    e.preventDefault();
    const v = Math.max(0, Math.floor(Number(String(f.float.value).replace(/[^\d]/g, '')) || 0));
    commit({ type: 'shift', shift: { id: uid('s'), openedAt: Date.now(), openedBy: device, float: v, closedAt: null } });
    toast(`準備金 ${yen(v)} でレジを開けました`);
  } else if (f.id === 'composer') {
    e.preventDefault();
    askAI($('#prompt').value);
  } else if (f.id === 'deviceForm') {
    e.preventDefault();
    device = f.device.value.trim().slice(0, 30);
    lsSet(LS.device, device);
    toast('端末の名前を保存しました');
  }
});
document.addEventListener('keydown', (e) => {
  // Enter で送信、Shift+Enter で改行（日本語変換中の Enter は送らない）
  if (e.target.id === 'prompt' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); askAI(e.target.value); return; }
  if (payOpen && e.key === 'Escape') { payOpen = false; renderRegister(); return; }
  if (!$('#done').hidden && (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ')) { e.preventDefault(); $('#done').hidden = true; return; }
  if (e.key === 'Enter' && ui.view === 'register' && !$('#sheet').open) {
    const go = $$('[data-go="checkout"]').pop();
    if (go && !go.disabled && (e.target === document.body || e.target.id === 'tenderInput')) { e.preventDefault(); checkout(); }
  }
});
window.addEventListener('hashchange', route);
window.addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });

setupMic();
route();
sync();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
