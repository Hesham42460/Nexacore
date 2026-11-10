// NexaCore server: multi-company, role-based permissions, double-entry accounting.
// Requires Node >= 22.5 (built-in node:sqlite). No npm dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { master, openCompany, createCompany, hashPw, newSalt, checkPw, MODULES } = require('./db');

const PORT = process.env.PORT || 3000;
const TTL = 12 * 3600 * 1000;
class HttpError extends Error { constructor(c, m) { super(m); this.code = c; } }
const bad = (m) => new HttpError(400, m);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const tx = (db, fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

const sessions = new Map(); // token -> {owner, company, userId, exp}
const fails = new Map();    // login throttle

// ================= accounting core =================
function acc(db, key) {
  const code = db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
  const a = db.prepare('SELECT * FROM accounts WHERE code=?').get(code);
  if (!a) throw bad(`account for "${key}" not found in chart of accounts (check Settings)`);
  return a;
}
function post(db, user, { date, memo, source = 'manual', source_id = null, lines }) {
  const ls = lines.map((l) => ({ account_id: l.account_id, debit: r2(num(l.debit)), credit: r2(num(l.credit)), memo: l.memo || null }))
    .filter((l) => l.debit > 0 || l.credit > 0);
  if (ls.length < 2) throw bad('entry needs at least two lines');
  if (ls.some((l) => l.debit < 0 || l.credit < 0 || (l.debit > 0 && l.credit > 0))) throw bad('each line must be either debit or credit');
  const D = r2(ls.reduce((s, l) => s + l.debit, 0)), C = r2(ls.reduce((s, l) => s + l.credit, 0));
  if (D !== C) throw bad(`entry not balanced (debit ${D} / credit ${C})`);
  const n = (db.prepare('SELECT MAX(id) m FROM entries').get().m || 0) + 1;
  const e = db.prepare('INSERT INTO entries(number,date,memo,source,source_id,created_by) VALUES(?,?,?,?,?,?)')
    .run('JE-' + String(n).padStart(5, '0'), isDate(date) ? date : today(), memo || null, source, source_id, user);
  const ins = db.prepare('INSERT INTO lines(entry_id,account_id,debit,credit,memo) VALUES(?,?,?,?,?)');
  for (const l of ls) {
    if (!db.prepare('SELECT 1 FROM accounts WHERE id=?').get(l.account_id)) throw bad('unknown account');
    ins.run(Number(e.lastInsertRowid), l.account_id, l.debit, l.credit, l.memo);
  }
  return Number(e.lastInsertRowid);
}
const unpost = (db, source, id) => db.prepare('DELETE FROM entries WHERE source=? AND source_id=?').run(source, id);
const L = (account, debit, credit) => ({ account_id: account.id, debit, credit });

// ================= resources =================
const RES = {
  customers: ['name', 'phone', 'address'],
  suppliers: ['name', 'phone', 'address'],
  products: ['name', 'sku', 'price', 'cost', 'stock'],
  expenses: ['category', 'amount', 'date', 'note', 'account_code'],
  employees: ['name', 'position', 'salary'],
  payroll: ['employee_id', 'month', 'amount', 'note'],
};
const NUMERIC = new Set(['price', 'cost', 'stock', 'amount', 'salary']);

function repost(db, user, kind, id) {
  unpost(db, kind, id);
  const cash = acc(db, 'acc.cash');
  if (kind === 'expenses') {
    const x = db.prepare('SELECT * FROM expenses WHERE id=?').get(id);
    const exp = x.account_code ? db.prepare('SELECT * FROM accounts WHERE code=?').get(x.account_code) : acc(db, 'acc.expense');
    if (!exp) throw bad('unknown expense account');
    post(db, user, { date: x.date, memo: x.category || 'expense', source: kind, source_id: id, lines: [L(exp, x.amount, 0), L(cash, 0, x.amount)] });
  } else if (kind === 'payroll') {
    const x = db.prepare('SELECT p.*, e.name en FROM payroll p LEFT JOIN employees e ON e.id=p.employee_id WHERE p.id=?').get(id);
    post(db, user, { date: (x.month || today().slice(0, 7)) + '-28', memo: `payroll ${x.en || ''} ${x.month || ''}`, source: kind, source_id: id, lines: [L(acc(db, 'acc.salaries'), x.amount, 0), L(cash, 0, x.amount)] });
  }
}

function crud(db, user, r, method, id, b) {
  const cols = RES[r];
  if (method === 'GET') return db.prepare(`SELECT * FROM ${r} ORDER BY id DESC`).all();
  if (method === 'DELETE') {
    return tx(db, () => {
      unpost(db, r, id);
      try { db.prepare(`DELETE FROM ${r} WHERE id=?`).run(id); } catch { throw new HttpError(409, 'record is in use'); }
      return { ok: true };
    });
  }
  const vals = cols.map((c) => (NUMERIC.has(c) ? num(b[c]) : (b[c] === '' ? null : b[c] ?? null)));
  if (cols.includes('name') && !String(b.name || '').trim()) throw bad('name required');
  if (r === 'expenses' || r === 'payroll') { if (num(b.amount) <= 0) throw bad('amount must be > 0'); }
  if (r === 'expenses' && !isDate(b.date)) vals[cols.indexOf('date')] = today();
  return tx(db, () => {
    let rid = id;
    if (method === 'POST') rid = Number(db.prepare(`INSERT INTO ${r}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...vals).lastInsertRowid);
    else db.prepare(`UPDATE ${r} SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`).run(...vals, id);
    if (r === 'expenses' || r === 'payroll') repost(db, user, r, rid);
    return { id: rid };
  });
}

// ================= invoices / purchases =================
const DOC = {
  invoices: { party: 'customer_id', ptable: 'customers', prefix: 'INV-', sign: -1 },
  purchases: { party: 'supplier_id', ptable: 'suppliers', prefix: 'PUR-', sign: 1 },
};
function docPost(db, user, kind, d, cost) {
  const sales = kind === 'invoices';
  const net = r2(d.subtotal - d.discount), due = r2(d.total - d.paid);
  const cash = acc(db, 'acc.cash');
  const lines = [];
  if (sales) {
    lines.push(L(cash, d.paid, 0), L(acc(db, 'acc.ar'), due, 0), L(acc(db, 'acc.sales'), 0, net), L(acc(db, 'acc.vat_out'), 0, d.tax));
    if (cost > 0) lines.push(L(acc(db, 'acc.cogs'), cost, 0), L(acc(db, 'acc.inventory'), 0, cost));
  } else {
    lines.push(L(acc(db, 'acc.inventory'), net, 0), L(acc(db, 'acc.vat_in'), d.tax, 0), L(cash, 0, d.paid), L(acc(db, 'acc.ap'), 0, due));
  }
  post(db, user, { date: d.date, memo: d.number, source: kind, source_id: d.id, lines });
}
function docCreate(db, user, kind, b) {
  const cfg = DOC[kind];
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) throw bad('items required');
  return tx(db, () => {
    let subtotal = 0, cost = 0;
    const clean = items.map((it) => {
      const p = db.prepare('SELECT * FROM products WHERE id=?').get(it.product_id);
      if (!p) throw bad('unknown product');
      const qty = num(it.qty), price = num(it.price);
      if (qty <= 0 || price < 0) throw bad('invalid qty/price');
      if (cfg.sign < 0 && p.stock < qty) throw bad(`insufficient stock: ${p.name}`);
      subtotal += qty * price; cost += qty * p.cost;
      db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(cfg.sign * qty, p.id);
      return { product_id: p.id, name: p.name, qty, price, cost: p.cost };
    });
    subtotal = r2(subtotal);
    const discount = r2(Math.min(Math.max(num(b.discount), 0), subtotal));
    const rate = Math.min(Math.max(num(b.tax_rate), 0), 100);
    const tax = r2((subtotal - discount) * rate / 100), total = r2(subtotal - discount + tax);
    const paid = r2(Math.min(Math.max(num(b.paid), 0), total));
    const n = (db.prepare(`SELECT MAX(id) m FROM ${kind}`).get().m || 0) + 1;
    const number = cfg.prefix + String(n).padStart(5, '0');
    const date = isDate(b.date) ? b.date : today();
    const id = Number(db.prepare(`INSERT INTO ${kind}(number,${cfg.party},date,subtotal,discount,tax_rate,tax,total,paid,items,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(number, b[cfg.party] ? Number(b[cfg.party]) : null, date, subtotal, discount, rate, tax, total, paid, JSON.stringify(clean), b.note || null).lastInsertRowid);
    docPost(db, user, kind, { id, number, date, subtotal, discount, tax, total, paid }, cost);
    return { id, number, total };
  });
}
function docPay(db, user, kind, id, amount) {
  const sales = kind === 'invoices';
  return tx(db, () => {
    const d = db.prepare(`SELECT * FROM ${kind} WHERE id=?`).get(id);
    if (!d) throw new HttpError(404, 'not found');
    const pay = r2(Math.min(num(amount), d.total - d.paid));
    if (pay <= 0) throw bad('invalid payment');
    db.prepare(`UPDATE ${kind} SET paid=? WHERE id=?`).run(r2(d.paid + pay), id);
    const cash = acc(db, 'acc.cash');
    post(db, user, { date: today(), memo: `payment ${d.number}`, source: kind, source_id: id,
      lines: sales ? [L(cash, pay, 0), L(acc(db, 'acc.ar'), 0, pay)] : [L(acc(db, 'acc.ap'), pay, 0), L(cash, 0, pay)] });
    return { ok: true };
  });
}
function docDelete(db, kind, id) {
  return tx(db, () => {
    const d = db.prepare(`SELECT * FROM ${kind} WHERE id=?`).get(id);
    if (!d) throw new HttpError(404, 'not found');
    for (const it of JSON.parse(d.items)) db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(-DOC[kind].sign * it.qty, it.product_id);
    unpost(db, kind, id);
    db.prepare(`DELETE FROM ${kind} WHERE id=?`).run(id);
    return { ok: true };
  });
}

// ================= reports =================
const DEBIT_NORMAL = new Set(['asset', 'expense']);
function balances(db, from, to) {
  return db.prepare(`SELECT a.id, a.code, a.name, a.name_en, a.type, COALESCE(SUM(l.debit),0) debit, COALESCE(SUM(l.credit),0) credit
    FROM accounts a LEFT JOIN lines l ON l.account_id=a.id LEFT JOIN entries e ON e.id=l.entry_id AND e.date>=? AND e.date<=?
    WHERE l.id IS NULL OR e.id IS NOT NULL GROUP BY a.id ORDER BY a.code`).all(from, to)
    .map((a) => ({ ...a, debit: r2(a.debit), credit: r2(a.credit), balance: r2(DEBIT_NORMAL.has(a.type) ? a.debit - a.credit : a.credit - a.debit) }));
}
function report(db, name, q) {
  const from = isDate(q.get('from')) ? q.get('from') : '0000-01-01', to = isDate(q.get('to')) ? q.get('to') : '9999-12-31';
  if (name === 'trial') {
    const rows = balances(db, from, to).filter((a) => a.debit || a.credit);
    return { rows, debit: r2(rows.reduce((s, a) => s + a.debit, 0)), credit: r2(rows.reduce((s, a) => s + a.credit, 0)) };
  }
  if (name === 'income') {
    const rows = balances(db, from, to).filter((a) => (a.type === 'revenue' || a.type === 'expense') && a.balance);
    const rev = r2(rows.filter((a) => a.type === 'revenue').reduce((s, a) => s + a.balance, 0));
    const exp = r2(rows.filter((a) => a.type === 'expense').reduce((s, a) => s + a.balance, 0));
    return { rows, revenue: rev, expenses: exp, net: r2(rev - exp) };
  }
  if (name === 'balance') {
    const all = balances(db, '0000-01-01', to);
    const sect = (t) => all.filter((a) => a.type === t && a.balance);
    const net = r2(all.filter((a) => a.type === 'revenue').reduce((s, a) => s + a.balance, 0) - all.filter((a) => a.type === 'expense').reduce((s, a) => s + a.balance, 0));
    const sum = (arr) => r2(arr.reduce((s, a) => s + a.balance, 0));
    const assets = sect('asset'), liabilities = sect('liability'), equity = sect('equity');
    return { assets, liabilities, equity, netIncome: net, totalAssets: sum(assets), totalLiabilities: sum(liabilities), totalEquity: r2(sum(equity) + net) };
  }
  if (name === 'ledger') {
    const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(Number(q.get('account_id')));
    if (!a) throw bad('account required');
    const sgn = DEBIT_NORMAL.has(a.type) ? 1 : -1;
    const open = db.prepare('SELECT COALESCE(SUM(l.debit-l.credit),0) b FROM lines l JOIN entries e ON e.id=l.entry_id WHERE l.account_id=? AND e.date<?').get(a.id, from).b;
    let run = r2(sgn * open);
    const rows = db.prepare(`SELECT e.id eid, e.number, e.date, COALESCE(l.memo,e.memo) memo, l.debit, l.credit FROM lines l JOIN entries e ON e.id=l.entry_id
      WHERE l.account_id=? AND e.date>=? AND e.date<=? ORDER BY e.date, e.id, l.id`).all(a.id, from, to)
      .map((x) => ({ ...x, balance: (run = r2(run + sgn * (x.debit - x.credit))) }));
    return { account: a, opening: r2(sgn * open), rows, closing: run };
  }
  throw new HttpError(404, 'unknown report');
}
function summary(db) {
  const inc = report(db, 'income', new URLSearchParams()), bal = report(db, 'balance', new URLSearchParams());
  const accBal = (key) => { try { const a = acc(db, key); return balances(db, '0000-01-01', '9999-12-31').find((x) => x.id === a.id)?.balance || 0; } catch { return 0; } };
  return {
    revenue: inc.revenue, expenses: inc.expenses, profit: inc.net, cash: accBal('acc.cash'),
    receivable: accBal('acc.ar'), payable: accBal('acc.ap'), stockValue: r2(db.prepare('SELECT COALESCE(SUM(stock*cost),0) v FROM products').get().v),
    totalAssets: bal.totalAssets,
    lowStock: db.prepare('SELECT id,name,stock FROM products WHERE stock<=5 ORDER BY stock LIMIT 10').all(),
    monthly: db.prepare('SELECT substr(date,1,7) m, SUM(subtotal-discount) v FROM invoices GROUP BY m ORDER BY m DESC LIMIT 6').all().reverse(),
  };
}

// ================= http helpers =================
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok, no) => {
  let s = ''; req.on('data', (c) => { s += c; if (s.length > 2e6) { no(new HttpError(413, 'too large')); req.destroy(); } });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(bad('bad json')); } });
});
const newToken = (data) => { const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, { ...data, exp: Date.now() + TTL }); return t; };
function throttle(key, ok) {
  const f = fails.get(key) || { n: 0, until: 0 };
  if (f.until > Date.now()) throw new HttpError(429, 'too many attempts, try again later');
  if (ok) fails.delete(key); else { f.n++; if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; } fails.set(key, f); }
}
function companyState(c) {
  if (c.status !== 'active') return 'suspended';
  if (c.expires && c.expires < today()) return 'expired';
  return 'ok';
}
const can = (perms, p) => perms.includes('*') || perms.includes(p);

// ================= api =================
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  const [r, a2, a3] = parts; const M = req.method;
  const ip = req.socket.remoteAddress;

  if (r === 'companies' && M === 'GET') // public list for the login dropdown (code + name only)
    return send(res, 200, master.prepare('SELECT code,name FROM companies ORDER BY name').all());

  if (r === 'login' && M === 'POST') {
    const b = await readBody(req);
    const key = `${ip}|${b.company}|${b.username}`;
    throttle(key, false);
    const c = master.prepare('SELECT * FROM companies WHERE code=?').get(String(b.company || ''));
    const db = c && openCompany(c.code);
    const u = db && db.prepare('SELECT * FROM users WHERE username=?').get(String(b.username || ''));
    if (!u || !u.active || !checkPw(b.password || '', u.salt, u.hash)) throw new HttpError(401, 'invalid credentials');
    const st = companyState(c);
    if (st !== 'ok') throw new HttpError(403, st);
    throttle(key, true);
    return send(res, 200, { token: newToken({ company: c.code, userId: u.id }) });
  }
  if (r === 'owner' && a2 === 'login' && M === 'POST') {
    const b = await readBody(req);
    const key = `${ip}|owner|${b.username}`;
    throttle(key, false);
    const o = master.prepare('SELECT * FROM owners WHERE username=?').get(String(b.username || ''));
    if (!o || !checkPw(b.password || '', o.salt, o.hash)) throw new HttpError(401, 'invalid credentials');
    throttle(key, true);
    return send(res, 200, { token: newToken({ owner: o.id }) });
  }

  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  const s = sessions.get(tok);
  if (!s || s.exp < Date.now()) { sessions.delete(tok); throw new HttpError(401, 'unauthorized'); }

  // ----- owner area -----
  if (r === 'owner') {
    if (!s.owner) throw new HttpError(403, 'forbidden');
    if (a2 === 'companies' && M === 'GET') return send(res, 200, master.prepare('SELECT * FROM companies ORDER BY id').all());
    if (a2 === 'companies' && M === 'POST') { createCompany(await readBody(req)); return send(res, 201, { ok: true }); }
    if (a2 === 'companies' && M === 'PUT' && a3) {
      const b = await readBody(req);
      const c = master.prepare('SELECT * FROM companies WHERE id=?').get(Number(a3));
      if (!c) throw new HttpError(404, 'not found');
      master.prepare('UPDATE companies SET name=?, status=?, expires=? WHERE id=?').run(b.name || c.name, b.status === 'suspended' ? 'suspended' : 'active', b.expires || null, c.id);
      if (b.admin_password) {
        if (String(b.admin_password).length < 6) throw bad('password too short');
        const db = openCompany(c.code), salt = newSalt();
        db.prepare('UPDATE users SET salt=?, hash=?, active=1 WHERE id=(SELECT id FROM users WHERE role_id=1 ORDER BY id LIMIT 1)').run(salt, hashPw(b.admin_password, salt));
      }
      return send(res, 200, { ok: true });
    }
    if (a2 === 'password' && M === 'POST') {
      const b = await readBody(req);
      if (String(b.password || '').length < 6) throw bad('password too short');
      const salt = newSalt();
      master.prepare('UPDATE owners SET salt=?, hash=? WHERE id=?').run(salt, hashPw(b.password, salt), s.owner);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'not found');
  }
  if (s.owner) throw new HttpError(403, 'owner session cannot access company data');

  // ----- company area -----
  const c = master.prepare('SELECT * FROM companies WHERE code=?').get(s.company);
  if (!c || companyState(c) !== 'ok') { sessions.delete(tok); throw new HttpError(403, 'suspended'); }
  const db = openCompany(s.company);
  const user = db.prepare('SELECT u.*, r.name role, r.perms FROM users u JOIN roles r ON r.id=u.role_id WHERE u.id=?').get(s.userId);
  if (!user || !user.active) { sessions.delete(tok); throw new HttpError(401, 'unauthorized'); }
  const perms = JSON.parse(user.perms);
  const need = (mod, write) => { if (!can(perms, `${mod}.${write ? 'edit' : 'view'}`)) throw new HttpError(403, 'forbidden'); };
  const write = M !== 'GET';
  const id = a2 && /^\d+$/.test(a2) ? Number(a2) : null;

  if (r === 'me') {
    const st = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((x) => [x.key, x.value]));
    return send(res, 200, { username: user.username, full_name: user.full_name, role: user.role, perms, company: { code: c.code, name: st.company_name || c.name, expires: c.expires, logo: st.logo || '', phone: st.company_phone || '', address: st.company_address || '', tax_no: st.tax_no || '' }, currency: st.currency });
  }
  if (r === 'password' && M === 'POST') {
    const b = await readBody(req);
    if (String(b.password || '').length < 6) throw bad('password too short');
    if (!checkPw(b.old || '', user.salt, user.hash)) throw new HttpError(403, 'wrong current password');
    const salt = newSalt();
    db.prepare('UPDATE users SET salt=?,hash=? WHERE id=?').run(salt, hashPw(b.password, salt), user.id);
    return send(res, 200, { ok: true });
  }
  if (r === 'summary') { need('reports'); return send(res, 200, summary(db)); }
  if (r === 'reports') { need('reports'); return send(res, 200, report(db, a2, url.searchParams)); }
  if (r === 'backup' && M === 'POST') {
    need('settings', true);
    const dir = path.join(__dirname, 'data', 'backups'); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${s.company}-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`);
    return send(res, 200, { file: f });
  }

  if (r === 'settings') {
    need('settings', write);
    if (M === 'GET') return send(res, 200, Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((x) => [x.key, x.value])));
    const b = await readBody(req);
    const up = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const [k, v] of Object.entries(b)) {
      if (k === 'logo') { // company logo as a small data URL (empty string removes it)
        if (v && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) || v.length > 400000)) throw bad('invalid logo (png/jpeg/webp, max ~300KB)');
        up.run(k, String(v || '')); continue;
      }
      if (/^(company_phone|company_address|tax_no)$/.test(k)) { up.run(k, String(v || '').slice(0, 200)); continue; }
      if (!/^(company_name|currency|acc\.[a-z_]+)$/.test(k)) continue;
      if (k.startsWith('acc.') && !db.prepare('SELECT 1 FROM accounts WHERE code=?').get(String(v))) throw bad(`unknown account code ${v}`);
      up.run(k, String(v));
    }
    return send(res, 200, { ok: true });
  }

  if (r === 'accounts') {
    need('accounting', write);
    if (M === 'GET') return send(res, 200, db.prepare('SELECT * FROM accounts ORDER BY code').all());
    const b = id ? await readBody(req) : M === 'DELETE' ? {} : await readBody(req);
    if (M !== 'DELETE') {
      if (!/^\d{3,10}$/.test(String(b.code || ''))) throw bad('code must be 3-10 digits');
      if (!String(b.name || '').trim()) throw bad('name required');
      if (!['asset', 'liability', 'equity', 'revenue', 'expense'].includes(b.type)) throw bad('invalid type');
    }
    try {
      if (M === 'POST') return send(res, 201, { id: Number(db.prepare('INSERT INTO accounts(code,name,name_en,type) VALUES(?,?,?,?)').run(String(b.code), b.name, b.name_en || null, b.type).lastInsertRowid) });
      if (M === 'PUT' && id) {
        if (db.prepare('SELECT 1 FROM lines WHERE account_id=?').get(id) && db.prepare('SELECT type FROM accounts WHERE id=?').get(id)?.type !== b.type) throw bad('cannot change type of an account that has entries');
        db.prepare('UPDATE accounts SET code=?,name=?,name_en=?,type=? WHERE id=?').run(String(b.code), b.name, b.name_en || null, b.type, id);
        return send(res, 200, { ok: true });
      }
      if (M === 'DELETE' && id) {
        const a = db.prepare('SELECT code FROM accounts WHERE id=?').get(id);
        if (!a) throw new HttpError(404, 'not found');
        if (db.prepare('SELECT 1 FROM lines WHERE account_id=?').get(id) || db.prepare('SELECT 1 FROM settings WHERE key LIKE ? AND value=?').get('acc.%', a.code)) throw new HttpError(409, 'account is in use');
        db.prepare('DELETE FROM accounts WHERE id=?').run(id);
        return send(res, 200, { ok: true });
      }
    } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'account code exists'); throw e; }
  }

  if (r === 'entries') {
    need('accounting', write);
    if (M === 'GET') {
      const q = url.searchParams, from = isDate(q.get('from')) ? q.get('from') : '0000-01-01', to = isDate(q.get('to')) ? q.get('to') : '9999-12-31';
      const es = db.prepare('SELECT * FROM entries WHERE date>=? AND date<=? ORDER BY date DESC, id DESC LIMIT 500').all(from, to);
      const ls = db.prepare('SELECT l.*, a.code, a.name, a.name_en FROM lines l JOIN accounts a ON a.id=l.account_id WHERE l.entry_id=?');
      return send(res, 200, es.map((e) => ({ ...e, lines: ls.all(e.id) })));
    }
    if (M === 'POST') {
      const b = await readBody(req);
      const eid = tx(db, () => post(db, user.username, { date: b.date, memo: b.memo, lines: (b.lines || []).map((l) => ({ account_id: Number(l.account_id), debit: l.debit, credit: l.credit, memo: l.memo })) }));
      return send(res, 201, { id: eid });
    }
    if (M === 'DELETE' && id) {
      const e = db.prepare('SELECT source FROM entries WHERE id=?').get(id);
      if (!e) throw new HttpError(404, 'not found');
      if (e.source !== 'manual') throw new HttpError(409, 'automatic entries are removed by deleting their source document');
      db.prepare('DELETE FROM entries WHERE id=?').run(id);
      return send(res, 200, { ok: true });
    }
  }

  if (r === 'users') {
    need('users', write);
    if (M === 'GET') return send(res, 200, db.prepare('SELECT u.id,u.username,u.full_name,u.active,u.role_id,r.name role FROM users u JOIN roles r ON r.id=u.role_id ORDER BY u.id').all());
    const b = M === 'DELETE' ? {} : await readBody(req);
    if (M !== 'DELETE') {
      if (!db.prepare('SELECT 1 FROM roles WHERE id=?').get(Number(b.role_id))) throw bad('role required');
      if (M === 'POST' && (!/^[\w.@-]{3,40}$/.test(b.username || '') || String(b.password || '').length < 6)) throw bad('username (3+) and password (6+) required');
      if (b.password && String(b.password).length < 6) throw bad('password too short');
    }
    const adminCount = () => db.prepare('SELECT COUNT(*) c FROM users WHERE role_id=1 AND active=1').get().c;
    if (M === 'POST') {
      const salt = newSalt();
      try { return send(res, 201, { id: Number(db.prepare('INSERT INTO users(username,full_name,salt,hash,role_id,active) VALUES(?,?,?,?,?,1)').run(b.username, b.full_name || b.username, salt, hashPw(b.password, salt), Number(b.role_id)).lastInsertRowid) }); }
      catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'username exists'); throw e; }
    }
    if (M === 'PUT' && id) {
      const t = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      if (!t) throw new HttpError(404, 'not found');
      const active = b.active === false || b.active === 0 ? 0 : 1;
      if (t.role_id === 1 && (Number(b.role_id) !== 1 || !active) && t.active && adminCount() <= 1) throw new HttpError(409, 'cannot remove the last admin');
      db.prepare('UPDATE users SET full_name=?, role_id=?, active=? WHERE id=?').run(b.full_name || t.username, Number(b.role_id), active, id);
      if (b.password) { const salt = newSalt(); db.prepare('UPDATE users SET salt=?,hash=? WHERE id=?').run(salt, hashPw(b.password, salt), id); }
      return send(res, 200, { ok: true });
    }
    if (M === 'DELETE' && id) {
      const t = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      if (!t) throw new HttpError(404, 'not found');
      if (id === user.id) throw new HttpError(409, 'cannot delete yourself');
      if (t.role_id === 1 && adminCount() <= 1) throw new HttpError(409, 'cannot remove the last admin');
      db.prepare('DELETE FROM users WHERE id=?').run(id);
      return send(res, 200, { ok: true });
    }
  }

  if (r === 'roles') {
    need('users', write);
    if (M === 'GET') return send(res, 200, { modules: MODULES, roles: db.prepare('SELECT * FROM roles ORDER BY id').all().map((x) => ({ ...x, perms: JSON.parse(x.perms) })) });
    const b = M === 'DELETE' ? {} : await readBody(req);
    if (M !== 'DELETE') {
      if (!String(b.name || '').trim()) throw bad('name required');
      const valid = new Set(MODULES.flatMap((m) => [m + '.view', m + '.edit']));
      b.perms = (Array.isArray(b.perms) ? b.perms : []).filter((p) => valid.has(p));
    }
    try {
      if (M === 'POST') return send(res, 201, { id: Number(db.prepare('INSERT INTO roles(name,perms) VALUES(?,?)').run(b.name, JSON.stringify(b.perms)).lastInsertRowid) });
      if (M === 'PUT' && id) {
        if (id === 1) throw new HttpError(409, 'the Admin role cannot be modified');
        db.prepare('UPDATE roles SET name=?, perms=? WHERE id=?').run(b.name, JSON.stringify(b.perms), id);
        return send(res, 200, { ok: true });
      }
      if (M === 'DELETE' && id) {
        if (id === 1) throw new HttpError(409, 'the Admin role cannot be deleted');
        if (db.prepare('SELECT 1 FROM users WHERE role_id=?').get(id)) throw new HttpError(409, 'role is assigned to users');
        db.prepare('DELETE FROM roles WHERE id=?').run(id);
        return send(res, 200, { ok: true });
      }
    } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'role name exists'); throw e; }
  }

  if (DOC[r]) {
    need(r, write);
    const cfg = DOC[r];
    if (M === 'GET') {
      const rows = db.prepare(`SELECT d.*, p.name party FROM ${r} d LEFT JOIN ${cfg.ptable} p ON p.id=d.${cfg.party} ORDER BY d.id DESC`).all();
      return send(res, 200, rows.map((x) => ({ ...x, items: JSON.parse(x.items) })));
    }
    if (M === 'POST') return send(res, 201, docCreate(db, user.username, r, await readBody(req)));
    if (M === 'PUT' && id) return send(res, 200, docPay(db, user.username, r, id, (await readBody(req)).payment));
    if (M === 'DELETE' && id) return send(res, 200, docDelete(db, r, id));
  }

  if (RES[r]) {
    // Sales/warehouse staff need to read lookup lists while creating documents.
    const lookup = !write && ((r === 'customers' && can(perms, 'invoices.edit')) || (r === 'suppliers' && can(perms, 'purchases.edit')) || (r === 'products' && (can(perms, 'invoices.edit') || can(perms, 'purchases.edit'))) || (r === 'employees' && can(perms, 'payroll.view')));
    if (!lookup) need(r, write);
    const b = M === 'POST' || M === 'PUT' ? await readBody(req) : {};
    if ((M === 'PUT' || M === 'DELETE') && !id) throw bad('id required');
    return send(res, M === 'POST' ? 201 : 200, crud(db, user.username, r, M, id, b));
  }
  throw new HttpError(404, 'not found');
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const pub = path.join(__dirname, 'public');
    const f = path.normalize(path.join(pub, decodeURIComponent(url.pathname) === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!f.startsWith(pub) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (e instanceof HttpError || Number.isInteger(e.code)) return send(res, e.code, { error: e.message });
    console.error(e); send(res, 500, { error: 'server error: ' + e.message });
  }
}).listen(PORT, () => console.log(`NexaCore running on http://localhost:${PORT}`));
