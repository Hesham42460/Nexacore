'use strict';
let lang = localStorage.lang || 'ar', theme = localStorage.theme || 'light';
let token = sessionStorage.token || '', isOwner = sessionStorage.owner === '1', me = null, ownerMode = false;
const t = (k) => (DICT[lang] && DICT[lang][k]) || k;
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const can = (m, w) => !!me && (me.perms.includes('*') || me.perms.includes(`${m}.${w || 'view'}`));
const aname = (a) => (lang === 'ar' ? a.name : a.name_en || a.name);
const typeLbl = (x) => t(x === 'revenue' ? 'revenueT' : x);

async function api(method, url, body) {
  const r = await fetch('/api/' + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if ((r.status === 401 || (r.status === 403 && /suspended|expired/.test(j.error))) && token) { doLogout(); }
    const e = new Error(j.error || r.statusText); e.status = r.status; throw e;
  }
  return j;
}
function toast(m) { const e = $('#toast'); e.textContent = m; e.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => e.classList.remove('on'), 2200); }
const fail = (e) => toast(t('err') + ': ' + e.message);
const guard = (fn) => (...a) => Promise.resolve(fn(...a)).catch(fail);
function modal(html) { $('#modalBox').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; }
$('#modal').addEventListener('mousedown', (e) => e.target.id === 'modal' && closeModal());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal());
const closeBtn = () => `<button type="button" class="btn" data-close>${t('close')}</button>`;
document.addEventListener('click', (e) => e.target.closest('[data-close]') && closeModal());

// ---------- theme / language ----------
function applyUi() {
  document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.documentElement.dataset.theme = theme;
  $('#themeBtn').textContent = theme === 'dark' ? t('light') : t('dark');
  $('#langBtn').textContent = $('#authLang').textContent = lang === 'ar' ? 'English' : 'العربية';
  $('#logoutBtn').textContent = t('logout');
  $('#authSub').textContent = t('authSub'); $('#lblCo').textContent = t('company'); $('#lblUser').textContent = t('username'); $('#lblPass').textContent = t('password');
  $('#loginBtn').textContent = t('login'); $('#ownerToggle').textContent = ownerMode ? t('userLogin') : t('ownerLogin');
  $('#coWrap').hidden = ownerMode;
}
$('#themeBtn').onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; localStorage.theme = theme; applyUi(); };
const toggleLang = () => { lang = lang === 'ar' ? 'en' : 'ar'; localStorage.lang = lang; applyUi(); if (me || isOwner) { if (token) { buildTabs(); route(); } } };
$('#langBtn').onclick = $('#authLang').onclick = toggleLang;

// ---------- auth ----------
async function loadCompanies() {
  try {
    const cs = await (await fetch('/api/companies')).json();
    $('#coSel').innerHTML = cs.map((c) => `<option value="${esc(c.code)}">${esc(c.name)} (${esc(c.code)})</option>`).join('');
    const last = localStorage.company; if (last) $('#coSel').value = last;
  } catch { /* ignore */ }
}
$('#ownerToggle').onclick = () => { ownerMode = !ownerMode; applyUi(); };
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault(); $('#authErr').textContent = '';
  try {
    const body = { username: $('#userInp').value.trim(), password: $('#passInp').value };
    if (!ownerMode) body.company = $('#coSel').value;
    token = ''; const r = await api('POST', ownerMode ? 'owner/login' : 'login', body);
    token = r.token; isOwner = ownerMode; sessionStorage.token = token; sessionStorage.owner = isOwner ? '1' : '0';
    if (!ownerMode) localStorage.company = body.company;
    $('#passInp').value = ''; await boot();
  } catch (er) {
    $('#authErr').textContent = er.status === 429 ? t('tooMany') : /suspended/.test(er.message) ? t('suspended') : /expired/.test(er.message) ? t('expired') : t('badLogin');
  }
};
function doLogout() {
  token = ''; me = null; isOwner = false; sessionStorage.clear(); $('#app').hidden = true; $('#auth').hidden = false; closeModal(); loadCompanies();
}
$('#logoutBtn').onclick = doLogout;

async function boot() {
  try {
    if (isOwner) me = { username: 'owner', perms: [], company: { name: t('owner') }, owner: true };
    else me = await api('GET', 'me');
  } catch { return doLogout(); }
  $('#auth').hidden = true; $('#app').hidden = false; buildTabs(); route();
}

// ---------- tabs / routing ----------
const TABS = ['dashboard', 'invoices', 'purchases', 'customers', 'suppliers', 'products', 'expenses', 'employees', 'payroll', 'accounting', 'users', 'settings'];
const SUBS = ['chart', 'entries', 'trial', 'ledger', 'income', 'balance'];
function buildTabs() {
  $('#brandName').textContent = me.company.name;
  $('#brandLogo').src = me.company.logo || 'logo-mark.png';
  $('#brandSub').textContent = isOwner ? '' : me.company.code + (me.company.expires ? ` · ${t('expires')}: ${me.company.expires}` : '');
  $('#userPill').textContent = `👤 ${isOwner ? t('owner') : (me.full_name || me.username)}${me.role ? ' · ' + me.role : ''}`;
  const tabs = isOwner ? ['companies'] : TABS.filter((x) => x === 'dashboard' || x === 'settings' ? true : can(x));
  $('#tabs').innerHTML = tabs.map((x) => `<button data-tab="${x}">${t(x)}</button>`).join('');
}
$('#tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) location.hash = b.dataset.tab; };
$('#subtabs').onclick = (e) => { const b = e.target.closest('[data-sub]'); if (b) location.hash = 'accounting/' + b.dataset.sub; };
window.addEventListener('hashchange', () => me && route());

function route() {
  const [tab0, sub0] = location.hash.slice(1).split('/');
  const allowed = $$('#tabs button').map((b) => b.dataset.tab);
  const tab = allowed.includes(tab0) ? tab0 : allowed[0];
  $$('#tabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
  const sub = SUBS.includes(sub0) ? sub0 : 'chart';
  $('#subtabs').hidden = tab !== 'accounting';
  if (tab === 'accounting') {
    $('#subtabs').innerHTML = SUBS.map((s) => `<button data-sub="${s}" aria-current="${s === sub ? 'page' : 'false'}">${t(s)}</button>`).join('');
  }
  const run = { companies: ownerView, dashboard, invoices: () => docs('invoices'), purchases: () => docs('purchases'), accounting: () => acct(sub), users: usersView, settings: settingsView }[tab] || (() => list(tab));
  Promise.resolve(run()).catch(fail);
}

// ---------- dashboard ----------
async function dashboard() {
  if (!can('reports')) { $('#main').innerHTML = `<div class="card"><p class="empty">${t('noPermDash')}</p></div>`; return; }
  const s = await api('GET', 'summary');
  const k = (l, v, c = '') => `<div class="kpi ${c}"><div class="k">${t(l)}</div><div class="v">${money(v)}</div></div>`;
  const max = Math.max(1, ...s.monthly.map((m) => m.v));
  $('#main').innerHTML = `<div class="kpis">${k('revenue', s.revenue)}${k('expensesT', s.expenses)}${k('profit', s.profit, s.profit < 0 ? 'warn' : '')}${k('cash', s.cash)}</div>
    <div class="kpis">${k('receivable', s.receivable)}${k('payable', s.payable)}${k('stockValue', s.stockValue)}${k('totalAssets', s.totalAssets)}</div>
    <div class="two"><div class="card"><h2>${t('monthly')}</h2><div class="chart">${s.monthly.map((m) => `<div style="height:${(m.v / max) * 100}%" title="${money(m.v)}"><span>${esc(m.m)}</span></div>`).join('') || `<p class="empty">${t('none')}</p>`}</div></div>
    <div class="card"><h2>${t('lowStock')}</h2>${s.lowStock.map((p) => `<div class="row"><span>${esc(p.name)}</span><b class="neg num">${money(p.stock)}</b></div>`).join('') || `<p class="empty">${t('none')}</p>`}</div></div>`;
}

// ---------- generic lists ----------
const RES = {
  customers: [['name'], ['phone'], ['address']], suppliers: [['name'], ['phone'], ['address']],
  products: [['name'], ['sku'], ['price', 'number'], ['cost', 'number'], ['stock', 'number']],
  expenses: [['category'], ['amount', 'number'], ['date', 'date'], ['account_code', 'acct'], ['note']],
  employees: [['name'], ['position'], ['salary', 'number']], payroll: [['employee_id', 'ref'], ['month', 'month'], ['amount', 'number'], ['note']],
};
async function list(r) {
  const cols = RES[r], edit = can(r, 'edit');
  const [rows, emps, accts] = await Promise.all([api('GET', r), r === 'payroll' ? api('GET', 'employees') : [], r === 'expenses' && can('accounting') ? api('GET', 'accounts') : []]);
  const en = Object.fromEntries(emps.map((e) => [e.id, e.name]));
  const an = Object.fromEntries(accts.map((a) => [a.code, `${a.code} ${aname(a)}`]));
  const cell = (x, [k, ty]) => (ty === 'ref' ? esc(en[x[k]] || '') : ty === 'acct' ? esc(an[x[k]] || x[k] || '') : ty === 'number' ? `<span class="num">${money(x[k])}</span>` : esc(x[k]));
  const draw = (q = '') => {
    const f = rows.filter((x) => JSON.stringify(Object.values(x)).toLowerCase().includes(q.toLowerCase()));
    $('#tb').innerHTML = f.map((x) => `<tr>${cols.map((c) => `<td>${cell(x, c)}</td>`).join('')}<td>${edit ? `<button class="btn sm" data-e="${x.id}">${t('edit')}</button> <button class="btn sm danger" data-d="${x.id}">${t('del')}</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="9"><p class="empty">${t('none')}</p></td></tr>`;
  };
  $('#main').innerHTML = `<div class="card"><div class="tools"><h2 class="grow">${t(r)}</h2><input id="q" placeholder="${t('search')}" style="max-width:240px">${edit ? `<button class="btn primary" id="add">${t('add')}</button>` : ''}</div>
    <div class="tw"><table class="tbl"><thead><tr>${cols.map((c) => `<th>${t(c[0])}</th>`).join('')}<th></th></tr></thead><tbody id="tb"></tbody></table></div></div>`;
  draw(); $('#q').oninput = (e) => draw(e.target.value);
  if (edit) $('#add').onclick = () => form(r, cols, {}, emps, accts);
  $('#tb').onclick = guard(async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.e) form(r, cols, rows.find((x) => x.id == b.dataset.e), emps, accts);
    if (b.dataset.d && confirm(t('confirmDel'))) { await api('DELETE', `${r}/${b.dataset.d}`); list(r); }
  });
}
function form(r, cols, row, emps, accts) {
  const inp = ([k, ty]) => {
    const v = row[k] ?? (ty === 'date' ? today() : ty === 'month' ? today().slice(0, 7) : '');
    let h;
    if (ty === 'ref') h = `<select name="${k}">${emps.map((e) => `<option value="${e.id}" ${e.id == v ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>`;
    else if (ty === 'acct') { if (!accts.length) return ''; h = `<select name="${k}"><option value=""></option>${accts.filter((a) => a.type === 'expense').map((a) => `<option value="${esc(a.code)}" ${a.code === v ? 'selected' : ''}>${esc(a.code)} ${esc(aname(a))}</option>`).join('')}</select>`; }
    else h = `<input name="${k}" type="${ty === 'number' ? 'number' : ty || 'text'}" ${ty === 'number' ? 'step="any"' : ''} value="${esc(v)}">`;
    return `<label class="f">${t(k)}${h}</label>`;
  };
  modal(`<form id="f"><h2>${t(row.id ? 'edit' : 'add')} — ${t(r)}</h2><div class="grid">${cols.map(inp).join('')}</div><div class="btns" style="margin-top:14px"><button class="btn primary">${t('save')}</button>${closeBtn()}</div></form>`);
  $('#f').onsubmit = guard(async (e) => { e.preventDefault(); await api(row.id ? 'PUT' : 'POST', row.id ? `${r}/${row.id}` : r, Object.fromEntries(new FormData(e.target))); closeModal(); list(r); });
}

// ---------- invoices / purchases ----------
const pillOf = (d) => (d.paid >= d.total ? ['p-paid', 'paidS'] : d.paid > 0 ? ['p-partial', 'partialS'] : ['p-unpaid', 'unpaidS']);
async function docs(kind) {
  const rows = await api('GET', kind), edit = can(kind, 'edit');
  $('#main').innerHTML = `<div class="card"><div class="tools"><h2 class="grow">${t(kind)}</h2>${edit ? `<button class="btn primary" id="add">${t('newDoc')}</button>` : ''}</div><div class="tw"><table class="tbl"><thead><tr>
    <th>${t('number')}</th><th>${t('date')}</th><th>${t('party')}</th><th class="r">${t('total')}</th><th class="r">${t('paid')}</th><th class="r">${t('due')}</th><th>${t('status')}</th><th></th></tr></thead><tbody>
    ${rows.map((d) => { const [c, l] = pillOf(d); return `<tr><td class="mono">${esc(d.number)}</td><td>${esc(d.date)}</td><td>${esc(d.party)}</td><td class="r">${money(d.total)}</td><td class="r">${money(d.paid)}</td><td class="r">${money(d.total - d.paid)}</td>
      <td><span class="pill ${c}">${t(l)}</span></td><td><button class="btn sm" data-v="${d.id}">${t('view')}</button>${edit && d.total > d.paid ? ` <button class="btn sm" data-p="${d.id}">${t('pay')}</button>` : ''}${edit ? ` <button class="btn sm danger" data-d="${d.id}">${t('del')}</button>` : ''}</td></tr>`; }).join('') || `<tr><td colspan="8"><p class="empty">${t('none')}</p></td></tr>`}</tbody></table></div></div>`;
  if (edit) $('#add').onclick = guard(() => docForm(kind));
  $('#main').onclick = guard(async (e) => {
    const b = e.target.closest('button[data-v],button[data-p],button[data-d]'); if (!b) return;
    if (b.dataset.v) docView(rows.find((x) => x.id == b.dataset.v), kind);
    if (b.dataset.p) { const v = prompt(t('payAmt')); if (v) { await api('PUT', `${kind}/${b.dataset.p}`, { payment: v }); docs(kind); } }
    if (b.dataset.d && confirm(t('confirmDel'))) { await api('DELETE', `${kind}/${b.dataset.d}`); docs(kind); }
  });
}
function docView(d, kind) {
  const co = me.company;
  modal(`<div class="inv-head">${co.logo ? `<img src="${esc(co.logo)}" alt="">` : ''}<div><h2>${esc(co.name)}</h2><p class="sub">${[co.address, co.phone, co.tax_no ? t('tax_no') + ': ' + co.tax_no : ''].filter(Boolean).map(esc).join(' · ')}</p></div></div>
    <h2>${t(kind)} — <span class="mono">${esc(d.number)}</span></h2><p class="sub">${esc(d.date)} · ${esc(d.party)}</p>
    <div class="tw"><table class="tbl"><thead><tr><th>${t('item')}</th><th class="r">${t('qty')}</th><th class="r">${t('price')}</th><th class="r">${t('total')}</th></tr></thead><tbody>
    ${d.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="r">${money(i.qty)}</td><td class="r">${money(i.price)}</td><td class="r">${money(i.qty * i.price)}</td></tr>`).join('')}</tbody></table></div>
    <div class="sum" style="max-width:320px;margin-inline-start:auto;margin-top:10px"><div class="r"><span>${t('subtotal')}</span><b>${money(d.subtotal)}</b></div><div class="r"><span>${t('discount')}</span><b>${money(d.discount)}</b></div>
    <div class="r"><span>${t('tax')} (${d.tax_rate}%)</span><b>${money(d.tax)}</b></div><div class="r"><span>${t('total')}</span><b>${money(d.total)}</b></div><div class="r"><span>${t('paid')}</span><b>${money(d.paid)}</b></div><div class="r"><span>${t('due')}</span><b>${money(d.total - d.paid)}</b></div></div>
    <div class="btns" style="margin-top:14px"><button class="btn primary" onclick="window.print()">${t('print')}</button>${closeBtn()}</div>`);
}
async function docForm(kind) {
  const inv = kind === 'invoices';
  const [parties, products] = await Promise.all([api('GET', inv ? 'customers' : 'suppliers'), api('GET', 'products')]);
  if (!products.length) return toast(t('products') + ': ' + t('none'));
  const line = () => `<div class="irow l"><select class="p">${products.map((p) => `<option value="${p.id}" data-pr="${inv ? p.price : p.cost}">${esc(p.name)} (${money(p.stock)})</option>`).join('')}</select>
    <input class="q" type="number" step="any" min="0" value="1" title="${t('qty')}"><input class="pr" type="number" step="any" min="0" title="${t('price')}"><span class="lt">0.00</span><button type="button" class="btn sm danger x">×</button></div>`;
  modal(`<form id="f"><h2>${t('newDoc')} — ${t(kind)}</h2><div class="grid"><label class="f">${t('party')}<select name="party"><option value=""></option>${parties.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
    <label class="f">${t('date')}<input name="date" type="date" value="${today()}"></label></div><div id="lines" style="margin-top:8px">${line()}</div>
    <button type="button" class="btn sm" id="addLine" style="margin-top:8px">${t('addLine')}</button>
    <div class="grid" style="margin-top:12px"><label class="f">${t('discount')}<input name="discount" type="number" step="any" min="0" value="0"></label><label class="f">${t('tax_rate')}<input name="tax_rate" type="number" step="any" min="0" max="100" value="0"></label>
    <label class="f">${t('paid')}<input name="paid" type="number" step="any" min="0" value="0"></label></div>
    <div class="sum" style="max-width:300px;margin-inline-start:auto;margin-top:10px"><div class="r"><span>${t('subtotal')}</span><b id="sSub">0.00</b></div><div class="r"><span>${t('tax')}</span><b id="sTax">0.00</b></div><div class="r"><span>${t('total')}</span><b id="sTot">0.00</b></div></div>
    <div class="btns" style="margin-top:14px"><button class="btn primary">${t('save')}</button>${closeBtn()}</div></form>`);
  const f = $('#f'), val = (n) => Number(f.elements[n].value) || 0;
  const sync = (l) => { l.querySelector('.pr').value = l.querySelector('.p').selectedOptions[0].dataset.pr; };
  const calc = () => {
    let sub = 0; $$('.l').forEach((l) => { const x = l.querySelector('.q').value * l.querySelector('.pr').value; l.querySelector('.lt').textContent = money(x); sub += x; });
    const net = Math.max(0, sub - val('discount')), tax = net * val('tax_rate') / 100;
    $('#sSub').textContent = money(sub); $('#sTax').textContent = money(tax); $('#sTot').textContent = money(net + tax);
  };
  const init = () => { $$('.l').forEach((l) => { if (!l.querySelector('.pr').value) sync(l); }); calc(); };
  init();
  $('#addLine').onclick = () => { $('#lines').insertAdjacentHTML('beforeend', line()); init(); };
  f.onchange = (e) => { if (e.target.classList.contains('p')) sync(e.target.closest('.l')); calc(); };
  f.oninput = calc;
  $('#lines').onclick = (e) => { if (e.target.classList.contains('x') && $$('.l').length > 1) { e.target.closest('.l').remove(); calc(); } };
  f.onsubmit = guard(async (e) => {
    e.preventDefault();
    const items = $$('.l').map((l) => ({ product_id: l.querySelector('.p').value, qty: l.querySelector('.q').value, price: l.querySelector('.pr').value }));
    await api('POST', kind, { [inv ? 'customer_id' : 'supplier_id']: f.elements.party.value, date: f.elements.date.value, discount: f.elements.discount.value, tax_rate: f.elements.tax_rate.value, paid: f.elements.paid.value, items });
    closeModal(); docs(kind);
  });
}

// ---------- accounting ----------
async function acct(sub) {
  if (sub === 'chart') return chartView();
  if (sub === 'entries') return entriesView();
  return reportView(sub);
}
async function chartView() {
  const rows = await api('GET', 'accounts'), edit = can('accounting', 'edit');
  const bal = can('reports') ? (await api('GET', 'reports/trial')).rows : [];
  const b = Object.fromEntries(bal.map((x) => [x.id, x.balance]));
  $('#main').innerHTML = `<div class="card"><div class="tools"><h2 class="grow">${t('chart')}</h2>${edit ? `<button class="btn primary" id="add">${t('newAccount')}</button>` : ''}</div><div class="tw"><table class="tbl"><thead><tr><th>${t('code')}</th><th>${t('name')}</th><th>${t('type')}</th><th class="r">${t('balance_')}</th><th></th></tr></thead><tbody>
    ${rows.map((a) => `<tr><td class="mono">${esc(a.code)}</td><td>${esc(aname(a))}</td><td><span class="pill p-info">${typeLbl(a.type)}</span></td><td class="r">${money(b[a.id])}</td><td>${edit ? `<button class="btn sm" data-e="${a.id}">${t('edit')}</button> <button class="btn sm danger" data-d="${a.id}">${t('del')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`;
  const form = (a) => {
    modal(`<form id="f"><h2>${t(a.id ? 'edit' : 'newAccount')}</h2><div class="grid"><label class="f">${t('code')}<input name="code" value="${esc(a.code)}" required></label>
      <label class="f">${t('type')}<select name="type">${['asset', 'liability', 'equity', 'revenue', 'expense'].map((x) => `<option value="${x}" ${a.type === x ? 'selected' : ''}>${typeLbl(x)}</option>`).join('')}</select></label>
      <label class="f">${t('name')} (AR)<input name="name" value="${esc(a.name)}" required></label><label class="f">${t('name')} (EN)<input name="name_en" value="${esc(a.name_en)}" dir="ltr"></label></div>
      <div class="btns" style="margin-top:14px"><button class="btn primary">${t('save')}</button>${closeBtn()}</div></form>`);
    $('#f').onsubmit = guard(async (e) => { e.preventDefault(); await api(a.id ? 'PUT' : 'POST', a.id ? `accounts/${a.id}` : 'accounts', Object.fromEntries(new FormData(e.target))); closeModal(); chartView(); });
  };
  if (edit) $('#add').onclick = () => form({});
  $('#main').onclick = guard(async (e) => {
    const x = e.target.closest('button'); if (!x) return;
    if (x.dataset.e) form(rows.find((a) => a.id == x.dataset.e));
    if (x.dataset.d && confirm(t('confirmDel'))) { await api('DELETE', `accounts/${x.dataset.d}`); chartView(); }
  });
}
DICT.ar.balance_ = 'الرصيد'; DICT.en.balance_ = 'Balance';

const range = (def) => `<label class="f">${t('from')}<input type="date" id="from" value="${def.from || ''}"></label><label class="f">${t('to')}<input type="date" id="to" value="${def.to || ''}"></label><button class="btn primary" id="go">${t('show')}</button><button class="btn" onclick="window.print()">${t('print')}</button>`;
async function entriesView() {
  const edit = can('accounting', 'edit'), accts = await api('GET', 'accounts');
  const q = new URLSearchParams(); const f = $('#from')?.value, to = $('#to')?.value; if (f) q.set('from', f); if (to) q.set('to', to);
  const rows = await api('GET', 'entries?' + q);
  const an = (l) => `${esc(l.code)} ${esc(aname(l))}`;
  $('#main').innerHTML = `<div class="card"><div class="tools"><h2 class="grow">${t('entries')}</h2>${range({ from: f, to })}${edit ? `<button class="btn primary" id="add">${t('newEntry')}</button>` : ''}</div>
    <div class="tw"><table class="tbl"><thead><tr><th>${t('number')}</th><th>${t('date')}</th><th>${t('memo')}</th><th>${t('account')}</th><th class="r">${t('debit')}</th><th class="r">${t('credit')}</th><th></th></tr></thead><tbody>
    ${rows.map((e) => e.lines.map((l, i) => `<tr>${i === 0 ? `<td class="mono" rowspan="${e.lines.length}">${esc(e.number)}</td><td rowspan="${e.lines.length}">${esc(e.date)}</td><td rowspan="${e.lines.length}">${esc(e.memo)} <span class="pill ${e.source === 'manual' ? 'p-info' : 'p-ok'}">${e.source === 'manual' ? t('manual') : t('auto')}</span></td>` : ''}
      <td>${an(l)}</td><td class="r">${l.debit ? money(l.debit) : ''}</td><td class="r">${l.credit ? money(l.credit) : ''}</td>${i === 0 ? `<td rowspan="${e.lines.length}">${edit && e.source === 'manual' ? `<button class="btn sm danger" data-d="${e.id}">${t('del')}</button>` : ''}</td>` : ''}</tr>`).join('')).join('') || `<tr><td colspan="7"><p class="empty">${t('none')}</p></td></tr>`}</tbody></table></div></div>`;
  $('#go').onclick = guard(entriesView);
  if (edit) $('#add').onclick = () => entryForm(accts);
  $('#main').onclick = guard(async (e) => { const b = e.target.closest('button[data-d]'); if (b && confirm(t('confirmDel'))) { await api('DELETE', `entries/${b.dataset.d}`); entriesView(); } });
}
function entryForm(accts) {
  const opts = accts.map((a) => `<option value="${a.id}">${esc(a.code)} ${esc(aname(a))}</option>`).join('');
  const line = () => `<div class="jrow j"><select class="a">${opts}</select><input class="d" type="number" step="any" min="0" placeholder="${t('debit')}"><input class="c" type="number" step="any" min="0" placeholder="${t('credit')}"><button type="button" class="btn sm danger x">×</button></div>`;
  modal(`<form id="f"><h2>${t('newEntry')}</h2><div class="grid"><label class="f">${t('date')}<input name="date" type="date" value="${today()}"></label><label class="f">${t('memo')}<input name="memo"></label></div>
    <div id="js" style="margin-top:8px">${line()}${line()}</div><button type="button" class="btn sm" id="al">${t('addLine')}</button>
    <p id="bal" class="sub" style="margin-top:10px"></p><div class="btns" style="margin-top:10px"><button class="btn primary">${t('save')}</button>${closeBtn()}</div></form>`);
  const calc = () => {
    const D = $$('.j .d').reduce((s, i) => s + Number(i.value || 0), 0), C = $$('.j .c').reduce((s, i) => s + Number(i.value || 0), 0), diff = Math.round((D - C) * 100) / 100;
    $('#bal').innerHTML = diff === 0 && D > 0 ? `<span class="pos">${t('balanced')}</span> (${money(D)})` : `<span class="neg">${t('diff')}: ${money(diff)}</span> — ${t('debit')} ${money(D)} / ${t('credit')} ${money(C)}`;
  };
  calc(); $('#f').oninput = calc;
  $('#al').onclick = () => $('#js').insertAdjacentHTML('beforeend', line());
  $('#js').onclick = (e) => { if (e.target.classList.contains('x') && $$('.j').length > 2) { e.target.closest('.j').remove(); calc(); } };
  $('#f').onsubmit = guard(async (e) => {
    e.preventDefault();
    const lines = $$('.j').map((j) => ({ account_id: j.querySelector('.a').value, debit: j.querySelector('.d').value, credit: j.querySelector('.c').value }));
    await api('POST', 'entries', { date: e.target.elements.date.value, memo: e.target.elements.memo.value, lines }); closeModal(); entriesView();
  });
}
async function reportView(name) {
  const yr = new Date().getFullYear();
  const prev = { from: $('#from')?.value || `${yr}-01-01`, to: $('#to')?.value || today() };
  const accts = name === 'ledger' ? await api('GET', 'accounts') : [];
  const prevAcc = $('#acc')?.value;
  const q = new URLSearchParams(); if (prev.from) q.set('from', prev.from); if (prev.to) q.set('to', prev.to);
  if (name === 'ledger') q.set('account_id', prevAcc || accts[0]?.id || '');
  const d = await api('GET', `reports/${name}?` + q);
  const nm = (a) => `<td class="mono">${esc(a.code)}</td><td>${esc(aname(a))}</td>`;
  let body = '';
  if (name === 'trial') body = `<table class="tbl"><thead><tr><th>${t('code')}</th><th>${t('name')}</th><th class="r">${t('debit')}</th><th class="r">${t('credit')}</th></tr></thead><tbody>${d.rows.map((a) => `<tr>${nm(a)}<td class="r">${money(a.debit)}</td><td class="r">${money(a.credit)}</td></tr>`).join('')}<tr class="total"><td colspan="2">${t('totals')}</td><td class="r">${money(d.debit)}</td><td class="r">${money(d.credit)}</td></tr></tbody></table>`;
  if (name === 'income') body = `<table class="tbl"><tbody><tr class="sec"><td colspan="3">${t('revenueT')}</td></tr>${d.rows.filter((a) => a.type === 'revenue').map((a) => `<tr>${nm(a)}<td class="r">${money(a.balance)}</td></tr>`).join('')}
    <tr class="total"><td colspan="2">${t('revenue')}</td><td class="r">${money(d.revenue)}</td></tr><tr class="sec"><td colspan="3">${t('expense')}</td></tr>${d.rows.filter((a) => a.type === 'expense').map((a) => `<tr>${nm(a)}<td class="r">${money(a.balance)}</td></tr>`).join('')}
    <tr class="total"><td colspan="2">${t('expensesT')}</td><td class="r">${money(d.expenses)}</td></tr><tr class="total"><td colspan="2">${t('profit')}</td><td class="r ${d.net < 0 ? 'neg' : 'pos'}">${money(d.net)}</td></tr></tbody></table>`;
  if (name === 'balance') {
    const sec = (lbl, arr, tot, key, extra = '') => `<tr class="sec"><td colspan="3">${lbl}</td></tr>${arr.map((a) => `<tr>${nm(a)}<td class="r">${money(a.balance)}</td></tr>`).join('')}${extra}<tr class="total"><td colspan="2">${key}</td><td class="r">${money(tot)}</td></tr>`;
    body = `<table class="tbl"><tbody>${sec(t('assets'), d.assets, d.totalAssets, t('totalAssets'))}${sec(t('liabilities'), d.liabilities, d.totalLiabilities, t('totalLiab'))}
      ${sec(t('equityS'), d.equity, d.totalEquity, t('totalEq'), `<tr><td colspan="2">${t('netIncome')}</td><td class="r">${money(d.netIncome)}</td></tr>`)}</tbody></table>
      <p class="sub" style="margin-top:8px">${d.totalAssets === Math.round((d.totalLiabilities + d.totalEquity) * 100) / 100 ? '<span class="pos">✔</span>' : '<span class="neg">≠</span>'} ${t('totalAssets')} = ${t('totalLiab')} + ${t('totalEq')}</p>`;
  }
  if (name === 'ledger') body = `<table class="tbl"><thead><tr><th>${t('date')}</th><th>${t('number')}</th><th>${t('memo')}</th><th class="r">${t('debit')}</th><th class="r">${t('credit')}</th><th class="r">${t('balance_')}</th></tr></thead><tbody>
    <tr class="total"><td colspan="5">${t('opening')}</td><td class="r">${money(d.opening)}</td></tr>${d.rows.map((x) => `<tr><td>${esc(x.date)}</td><td class="mono">${esc(x.number)}</td><td>${esc(x.memo)}</td><td class="r">${x.debit ? money(x.debit) : ''}</td><td class="r">${x.credit ? money(x.credit) : ''}</td><td class="r">${money(x.balance)}</td></tr>`).join('')}
    <tr class="total"><td colspan="5">${t('closing')}</td><td class="r">${money(d.closing)}</td></tr></tbody></table>`;
  const accSel = name === 'ledger' ? `<label class="f">${t('account')}<select id="acc">${accts.map((a) => `<option value="${a.id}" ${a.id == (prevAcc || accts[0]?.id) ? 'selected' : ''}>${esc(a.code)} ${esc(aname(a))}</option>`).join('')}</select></label>` : '';
  $('#main').innerHTML = `<div class="card"><div class="tools"><h2 class="grow">${t(name)} — ${esc(me.company.name)}</h2>${accSel}${name === 'balance' ? `<label class="f">${t('to')}<input type="date" id="to" value="${prev.to}"></label><button class="btn primary" id="go">${t('show')}</button><button class="btn" onclick="window.print()">${t('print')}</button>` : range(prev)}</div><div class="tw">${body}</div></div>`;
  $('#go').onclick = guard(() => reportView(name));
}

// ---------- users & roles ----------
const MODS = ['customers', 'suppliers', 'products', 'invoices', 'purchases', 'expenses', 'employees', 'payroll', 'accounting', 'reports', 'users', 'settings'];
async function usersView() {
  const [us, rr] = await Promise.all([api('GET', 'users'), api('GET', 'roles')]);
  const edit = can('users', 'edit'), roles = rr.roles;
  $('#main').innerHTML = `<div class="two"><div class="card"><div class="tools"><h2 class="grow">${t('usersT')}</h2>${edit ? `<button class="btn primary" id="addU">${t('newUser')}</button>` : ''}</div><div class="tw"><table class="tbl"><thead><tr><th>${t('username')}</th><th>${t('fullName')}</th><th>${t('role')}</th><th>${t('status')}</th><th></th></tr></thead><tbody>
    ${us.map((u) => `<tr><td class="mono">${esc(u.username)}</td><td>${esc(u.full_name)}</td><td>${esc(u.role)}</td><td><span class="pill ${u.active ? 'p-ok' : 'p-bad'}">${u.active ? t('activeS') : t('suspendedS')}</span></td><td>${edit ? `<button class="btn sm" data-eu="${u.id}">${t('edit')}</button> <button class="btn sm danger" data-du="${u.id}">${t('del')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="card"><div class="tools"><h2 class="grow">${t('roles')}</h2>${edit ? `<button class="btn primary" id="addR">${t('newRole')}</button>` : ''}</div><div class="tw"><table class="tbl"><thead><tr><th>${t('name')}</th><th>${t('permissions')}</th><th></th></tr></thead><tbody>
    ${roles.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.perms.includes('*') ? '*' : r.perms.length}</td><td>${edit && r.id !== 1 ? `<button class="btn sm" data-er="${r.id}">${t('edit')}</button> <button class="btn sm danger" data-dr="${r.id}">${t('del')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div></div>`;
  const userForm = (u) => {
    modal(`<form id="f"><h2>${t(u.id ? 'edit' : 'newUser')}</h2><div class="grid"><label class="f">${t('username')}<input name="username" value="${esc(u.username)}" ${u.id ? 'disabled' : 'required'} dir="ltr"></label><label class="f">${t('fullName')}<input name="full_name" value="${esc(u.full_name)}"></label>
      <label class="f">${t('role')}<select name="role_id">${roles.map((r) => `<option value="${r.id}" ${r.id == u.role_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
      <label class="f">${t('password')}${u.id ? ' (' + t('leaveBlank') + ')' : ''}<input name="password" type="password" dir="ltr" ${u.id ? '' : 'required'} autocomplete="new-password"></label>
      <label class="f" style="flex-direction:row;align-items:center;gap:6px"><input type="checkbox" name="active" style="width:auto" ${u.id && !u.active ? '' : 'checked'}> ${t('active')}</label></div>
      <div class="btns" style="margin-top:14px"><button class="btn primary">${t('save')}</button>${closeBtn()}</div></form>`);
    $('#f').onsubmit = guard(async (e) => {
      e.preventDefault(); const fd = e.target.elements;
      const body = { username: fd.username.value, full_name: fd.full_name.value, role_id: fd.role_id.value, password: fd.password.value, active: fd.active.checked };
      await api(u.id ? 'PUT' : 'POST', u.id ? `users/${u.id}` : 'users', body); closeModal(); usersView();
    });
  };
  const roleForm = (r) => {
    const has = (p) => r.perms && (r.perms.includes('*') || r.perms.includes(p));
    modal(`<form id="f"><h2>${t(r.id ? 'edit' : 'newRole')}</h2><label class="f">${t('name')}<input name="name" value="${esc(r.name)}" required></label>
      <div class="perm-grid" style="margin-top:12px"><b></b><b>${t('canView')}</b><b>${t('canEdit')}</b>${MODS.map((m) => `<span>${t(m)}</span><label><input type="checkbox" data-p="${m}.view" ${has(m + '.view') ? 'checked' : ''}></label><label><input type="checkbox" data-p="${m}.edit" ${has(m + '.edit') ? 'checked' : ''}></label>`).join('')}</div>
      <div class="btns" style="margin-top:14px"><button class="btn primary">${t('save')}</button>${closeBtn()}</div></form>`);
    $('#f').onchange = (e) => { const p = e.target.dataset.p; if (!p) return; const [m, k] = p.split('.'); if (k === 'edit' && e.target.checked) $(`[data-p="${m}.view"]`).checked = true; if (k === 'view' && !e.target.checked) $(`[data-p="${m}.edit"]`).checked = false; };
    $('#f').onsubmit = guard(async (e) => {
      e.preventDefault();
      await api(r.id ? 'PUT' : 'POST', r.id ? `roles/${r.id}` : 'roles', { name: e.target.elements.name.value, perms: $$('[data-p]').filter((c) => c.checked).map((c) => c.dataset.p) }); closeModal(); usersView();
    });
  };
  if (edit) { $('#addU').onclick = () => userForm({}); $('#addR').onclick = () => roleForm({ perms: [] }); }
  $('#main').onclick = guard(async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.eu) userForm(us.find((u) => u.id == b.dataset.eu));
    if (b.dataset.er) roleForm(roles.find((r) => r.id == b.dataset.er));
    if (b.dataset.du && confirm(t('confirmDel'))) { await api('DELETE', `users/${b.dataset.du}`); usersView(); }
    if (b.dataset.dr && confirm(t('confirmDel'))) { await api('DELETE', `roles/${b.dataset.dr}`); usersView(); }
  });
}

// Resize an uploaded logo to fit 400x200 and return it as a data URL (<300KB).
function shrinkImage(file) {
  return new Promise((ok, no) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return no(new Error('png / jpeg / webp only'));
    const url = URL.createObjectURL(file), img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); no(new Error('cannot read image')); };
    img.onload = () => {
      URL.revokeObjectURL(url);
      const k = Math.min(1, 400 / img.width, 200 / img.height), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      let d = c.toDataURL('image/png'); if (d.length > 300000) d = c.toDataURL('image/jpeg', 0.85);
      d.length > 390000 ? no(new Error('image too large')) : ok(d);
    };
    img.src = url;
  });
}

// ---------- settings ----------
async function settingsView() {
  const canSet = can('settings'), canEd = can('settings', 'edit');
  const [s, accts] = canSet ? await Promise.all([api('GET', 'settings'), can('accounting') ? api('GET', 'accounts') : []]) : [{}, []];
  const keys = ['acc.cash', 'acc.ar', 'acc.inventory', 'acc.ap', 'acc.sales', 'acc.cogs', 'acc.salaries', 'acc.expense', 'acc.vat_in', 'acc.vat_out'];
  $('#main').innerHTML = `<div class="two">${canSet ? `<div class="card"><h2>${t('settings')}</h2><form id="sf" class="stack"><div class="grid"><label class="f">${t('companyName')}<input name="company_name" value="${esc(s.company_name)}"></label><label class="f">${t('currency')}<input name="currency" value="${esc(s.currency)}"></label>
    <label class="f">${t('phone')}<input name="company_phone" value="${esc(s.company_phone)}"></label><label class="f">${t('tax_no')}<input name="tax_no" value="${esc(s.tax_no)}"></label><label class="f full">${t('address')}<input name="company_address" value="${esc(s.company_address)}"></label></div>
    <div class="f"><span>${t('logo')}</span><div class="row" style="justify-content:flex-start"><img id="logoPrev" class="logo-prev" ${s.logo ? `src="${esc(s.logo)}"` : 'hidden'} alt="">${canEd ? `<input type="file" id="logoFile" accept="image/png,image/jpeg,image/webp" style="width:auto"><button type="button" class="btn sm danger" id="logoDel">${t('removeLogo')}</button>` : ''}</div><span class="sub">${t('logoHint')}</span></div>
    <h2 style="font-size:13px">${t('accMap')}</h2><div class="grid">${keys.map((k) => `<label class="f">${t(k)}<select name="${k}">${accts.map((a) => `<option value="${esc(a.code)}" ${a.code === s[k] ? 'selected' : ''}>${esc(a.code)} ${esc(aname(a))}</option>`).join('')}</select></label>`).join('')}</div>
    ${canEd ? `<div class="btns"><button class="btn primary">${t('save')}</button><button type="button" class="btn" id="bk">${t('backup')}</button></div>` : ''}</form></div>` : ''}
    <div class="card"><h2>${t('changePass')}</h2><form id="pf" class="stack"><label class="f">${t('oldPass')}<input name="old" type="password" required autocomplete="current-password"></label><label class="f">${t('newPass')}<input name="password" type="password" minlength="6" required autocomplete="new-password"></label><div class="btns"><button class="btn primary">${t('save')}</button></div></form></div></div>`;
  if (canSet) {
    let newLogo; // undefined = unchanged, '' = remove, string = new data URL
    if (canEd) {
      $('#logoFile').onchange = guard(async (e) => {
        const f = e.target.files[0]; if (!f) return;
        newLogo = await shrinkImage(f); $('#logoPrev').src = newLogo; $('#logoPrev').hidden = false;
      });
      $('#logoDel').onclick = () => { newLogo = ''; $('#logoPrev').hidden = true; $('#logoFile').value = ''; };
    }
    $('#sf').onsubmit = guard(async (e) => {
      e.preventDefault(); if (!canEd) return;
      const b = Object.fromEntries(new FormData(e.target)); if (newLogo !== undefined) b.logo = newLogo;
      await api('PUT', 'settings', b); me = await api('GET', 'me'); buildTabs(); toast(t('saved'));
    });
    if (canEd) $('#bk').onclick = guard(async () => toast((await api('POST', 'backup')).file));
  }
  $('#pf').onsubmit = guard(async (e) => { e.preventDefault(); await api('POST', 'password', Object.fromEntries(new FormData(e.target))); e.target.reset(); toast(t('done')); });
}

// ---------- owner area ----------
async function ownerView() {
  const cs = await api('GET', 'owner/companies');
  $('#main').innerHTML = `<div class="two"><div class="card" style="grid-column:1/-1"><div class="tools"><h2 class="grow">${t('companies')}</h2><button class="btn primary" id="add">${t('newCompany')}</button></div><div class="tw"><table class="tbl"><thead><tr><th>${t('code2')}</th><th>${t('name')}</th><th>${t('status')}</th><th>${t('expires')}</th><th>${t('created')}</th><th></th></tr></thead><tbody>
    ${cs.map((c) => `<tr><td class="mono">${esc(c.code)}</td><td>${esc(c.name)}</td><td><span class="pill ${c.status === 'active' ? 'p-ok' : 'p-bad'}">${c.status === 'active' ? t('activeS') : t('suspendedS')}</span></td><td>${esc(c.expires || '—')}</td><td>${esc(c.created)}</td><td><button class="btn sm" data-e="${c.id}">${t('edit')}</button></td></tr>`).join('')}</tbody></table></div></div>
    <div class="card"><h2>${t('changePass')}</h2><form id="pf" class="stack"><label class="f">${t('newPass')}<input name="password" type="password" minlength="6" required autocomplete="new-password"></label><div class="btns"><button class="btn primary">${t('save')}</button></div></form></div></div>`;
  const form = (c) => {
    modal(`<form id="f"><h2>${t(c.id ? 'edit' : 'newCompany')}</h2><div class="grid"><label class="f">${t('code2')}<input name="code" value="${esc(c.code)}" ${c.id ? 'disabled' : 'required'} dir="ltr" pattern="[A-Za-z0-9_-]{2,20}"></label><label class="f">${t('name')}<input name="name" value="${esc(c.name)}" required></label>
      <label class="f">${t('expires')}<input name="expires" type="date" value="${esc(c.expires)}"></label>
      ${c.id ? `<label class="f">${t('status')}<select name="status"><option value="active" ${c.status === 'active' ? 'selected' : ''}>${t('activeS')}</option><option value="suspended" ${c.status === 'suspended' ? 'selected' : ''}>${t('suspendedS')}</option></select></label><label class="f">${t('resetAdmin')}<input name="admin_password" type="password" autocomplete="new-password"></label>`
        : `<label class="f">${t('adminUser')}<input name="admin_username" value="admin" required dir="ltr"></label><label class="f">${t('adminPass')}<input name="admin_password" type="password" minlength="6" required autocomplete="new-password"></label>`}</div>
      <div class="btns" style="margin-top:14px"><button class="btn primary">${t('save')}</button>${closeBtn()}</div></form>`);
    $('#f').onsubmit = guard(async (e) => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); if (c.id) await api('PUT', `owner/companies/${c.id}`, b); else await api('POST', 'owner/companies', b); closeModal(); ownerView(); });
  };
  $('#add').onclick = () => form({});
  $('#main').onclick = (e) => { const b = e.target.closest('[data-e]'); if (b) form(cs.find((c) => c.id == b.dataset.e)); };
  $('#pf').onsubmit = guard(async (e) => { e.preventDefault(); await api('POST', 'owner/password', Object.fromEntries(new FormData(e.target))); e.target.reset(); toast(t('done')); });
}

// ---------- init ----------
applyUi(); loadCompanies();
if (token) boot();
