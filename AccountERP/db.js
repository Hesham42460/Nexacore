// Database layer: master DB (companies, owner) + one SQLite file per company.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA = path.join(__dirname, 'data');
const CO_DIR = path.join(DATA, 'companies');
fs.mkdirSync(CO_DIR, { recursive: true });

const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
const newSalt = () => crypto.randomBytes(16).toString('hex');
const checkPw = (pw, salt, hash) => {
  const a = Buffer.from(hashPw(pw, salt), 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// ---------- master ----------
const master = new DatabaseSync(path.join(DATA, 'master.db'));
master.exec(`
CREATE TABLE IF NOT EXISTS companies(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, status TEXT DEFAULT 'active', expires TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS owners(id INTEGER PRIMARY KEY, username TEXT UNIQUE, salt TEXT, hash TEXT);
`);
if (!master.prepare('SELECT 1 FROM owners').get()) {
  const s = newSalt();
  master.prepare('INSERT INTO owners(username,salt,hash) VALUES(?,?,?)').run('owner', s, hashPw('owner123', s));
  console.log('Default OWNER login: owner / owner123  (change it!)');
}

// ---------- company schema ----------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS roles(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, perms TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, full_name TEXT, salt TEXT, hash TEXT, role_id INTEGER REFERENCES roles(id), active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, name_en TEXT, type TEXT NOT NULL CHECK(type IN('asset','liability','equity','revenue','expense')));
CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY, number TEXT, date TEXT NOT NULL, memo TEXT, source TEXT DEFAULT 'manual', source_id INTEGER, created_by TEXT);
CREATE TABLE IF NOT EXISTS lines(id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE, account_id INTEGER NOT NULL REFERENCES accounts(id), debit REAL DEFAULT 0, credit REAL DEFAULT 0, memo TEXT);
CREATE INDEX IF NOT EXISTS ix_lines_entry ON lines(entry_id); CREATE INDEX IF NOT EXISTS ix_lines_acc ON lines(account_id);
CREATE INDEX IF NOT EXISTS ix_entries_src ON entries(source, source_id);
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, address TEXT);
CREATE TABLE IF NOT EXISTS suppliers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, address TEXT);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT NOT NULL, sku TEXT, price REAL DEFAULT 0, cost REAL DEFAULT 0, stock REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY, category TEXT, amount REAL NOT NULL, date TEXT, note TEXT, account_code TEXT);
CREATE TABLE IF NOT EXISTS employees(id INTEGER PRIMARY KEY, name TEXT NOT NULL, position TEXT, salary REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS payroll(id INTEGER PRIMARY KEY, employee_id INTEGER REFERENCES employees(id), month TEXT, amount REAL NOT NULL, note TEXT);
CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY, number TEXT, customer_id INTEGER, date TEXT, subtotal REAL, discount REAL DEFAULT 0, tax_rate REAL DEFAULT 0, tax REAL DEFAULT 0, total REAL, paid REAL DEFAULT 0, items TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS purchases(id INTEGER PRIMARY KEY, number TEXT, supplier_id INTEGER, date TEXT, subtotal REAL, discount REAL DEFAULT 0, tax_rate REAL DEFAULT 0, tax REAL DEFAULT 0, total REAL, paid REAL DEFAULT 0, items TEXT, note TEXT);
`;

const MODULES = ['customers', 'suppliers', 'products', 'invoices', 'purchases', 'expenses', 'employees', 'payroll', 'accounting', 'reports', 'users', 'settings'];
const ALL_VIEW = MODULES.map((m) => m + '.view');
const ROLES = {
  'Admin': ['*'],
  'Accountant': ['accounting.view', 'accounting.edit', 'reports.view', 'expenses.view', 'expenses.edit', 'payroll.view', 'payroll.edit', 'employees.view', 'employees.edit', 'invoices.view', 'purchases.view', 'customers.view', 'suppliers.view', 'products.view'],
  'Sales': ['invoices.view', 'invoices.edit', 'customers.view', 'customers.edit', 'products.view'],
  'Warehouse': ['products.view', 'products.edit', 'purchases.view', 'purchases.edit', 'suppliers.view', 'suppliers.edit'],
  'Viewer': ALL_VIEW.filter((p) => !p.startsWith('users') && !p.startsWith('settings')),
};
const COA = [
  ['1100', 'الصندوق', 'Cash', 'asset'], ['1110', 'البنك', 'Bank', 'asset'], ['1200', 'العملاء', 'Accounts Receivable', 'asset'],
  ['1300', 'المخزون', 'Inventory', 'asset'], ['1400', 'ضريبة القيمة المضافة - مدخلات', 'VAT Input', 'asset'],
  ['2100', 'الموردون', 'Accounts Payable', 'liability'], ['2200', 'ضريبة القيمة المضافة - مخرجات', 'VAT Output', 'liability'],
  ['3100', 'رأس المال', 'Capital', 'equity'], ['3200', 'الأرباح المحتجزة', 'Retained Earnings', 'equity'],
  ['4100', 'إيرادات المبيعات', 'Sales Revenue', 'revenue'], ['4200', 'إيرادات أخرى', 'Other Revenue', 'revenue'],
  ['5100', 'تكلفة البضاعة المباعة', 'Cost of Goods Sold', 'expense'], ['5200', 'المرتبات والأجور', 'Salaries & Wages', 'expense'],
  ['5300', 'مصروفات عمومية', 'General Expenses', 'expense'], ['5400', 'الإيجارات', 'Rent', 'expense'], ['5500', 'الكهرباء والمياه', 'Utilities', 'expense'],
];
const DEFAULT_SETTINGS = {
  currency: 'EGP', 'acc.cash': '1100', 'acc.ar': '1200', 'acc.inventory': '1300', 'acc.ap': '2100', 'acc.sales': '4100',
  'acc.cogs': '5100', 'acc.salaries': '5200', 'acc.expense': '5300', 'acc.vat_in': '1400', 'acc.vat_out': '2200',
};

const COMPANY_CODE = /^[A-Za-z0-9_-]{2,20}$/;
const cache = new Map();
function openCompany(code) {
  if (!COMPANY_CODE.test(code)) return null;
  if (cache.has(code)) return cache.get(code);
  const f = path.join(CO_DIR, code + '.db');
  if (!fs.existsSync(f)) return null;
  const d = new DatabaseSync(f);
  d.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  cache.set(code, d);
  return d;
}

function createCompany({ code, name, admin_username, admin_password, expires }) {
  if (!COMPANY_CODE.test(code || '')) throw Object.assign(new Error('invalid company code (2-20 letters/digits/-/_)'), { code: 400 });
  if (!name || !admin_username || String(admin_password || '').length < 6) throw Object.assign(new Error('name, admin user and password (6+) required'), { code: 400 });
  if (master.prepare('SELECT 1 FROM companies WHERE code=?').get(code)) throw Object.assign(new Error('company code exists'), { code: 409 });
  const f = path.join(CO_DIR, code + '.db');
  const d = new DatabaseSync(f);
  d.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  d.exec(SCHEMA);
  const insR = d.prepare('INSERT INTO roles(name,perms) VALUES(?,?)');
  for (const [n, p] of Object.entries(ROLES)) insR.run(n, JSON.stringify(p));
  const insA = d.prepare('INSERT INTO accounts(code,name,name_en,type) VALUES(?,?,?,?)');
  COA.forEach((a) => insA.run(...a));
  const insS = d.prepare('INSERT INTO settings(key,value) VALUES(?,?)');
  insS.run('company_name', name);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insS.run(k, v);
  const salt = newSalt();
  d.prepare('INSERT INTO users(username,full_name,salt,hash,role_id) VALUES(?,?,?,?,1)').run(admin_username, admin_username, salt, hashPw(admin_password, salt));
  master.prepare('INSERT INTO companies(code,name,expires,created) VALUES(?,?,?,?)').run(code, name, expires || null, new Date().toISOString().slice(0, 10));
  cache.set(code, d);
  return d;
}

// Demo company on first run so the app is usable immediately.
if (!master.prepare('SELECT 1 FROM companies').get()) {
  createCompany({ code: 'COMP-001', name: 'شركة تجريبية', admin_username: 'admin', admin_password: 'admin123' });
  console.log('Demo company created: COMP-001 / admin / admin123');
}

module.exports = { master, openCompany, createCompany, hashPw, newSalt, checkPw, MODULES, DATA, CO_DIR };
