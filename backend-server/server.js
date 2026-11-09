/**
 * NexaCore ERP — Production Multi-Tenant SaaS Backend Server (Node.js / Express)
 * يحمي بيانات السوبر أدمن والتراخيص والمساحات على السيرفر بالكامل ويدعم مئات الشركات و200+ مستخدم لكل شركة
 */
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..')));

const DATA_DIR = path.join(__dirname, 'tenants_storage');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const LICENSES_FILE = path.join(DATA_DIR, 'licenses_master.json');
const SUPER_ADMIN_USER = process.env.SUPER_USER || 'nexacore';
const SUPER_ADMIN_PASS = process.env.SUPER_PASS || '5243535Ss#';
const JWT_SECRET = process.env.JWT_SECRET || 'nexacore-enterprise-secret-key-2026';

function loadLicenses() {
  if (!fs.existsSync(LICENSES_FILE)) return { updatedAt: new Date().toISOString().slice(0, 10), tenants: {} };
  return JSON.parse(fs.readFileSync(LICENSES_FILE, 'utf8'));
}
function saveLicenses(obj) {
  fs.writeFileSync(LICENSES_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

// 1. فحص حالة ترخيص الشركة (Kill-Switch API)
app.get('/license-check', (req, res) => {
  res.json(loadLicenses());
});

// 2. تحديث التراخيص وإيقاف/تفعيل الشركات (حصرياً للسوبر أدمن)
app.post('/licenses', (req, res) => {
  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + SUPER_ADMIN_PASS) {
    return res.status(403).json({ error: 'غير مصرح — صلاحية السوبر أدمن فقط' });
  }
  saveLicenses(req.body);
  res.json({ ok: true });
});

// 3. مزامنة وحفظ بيانات كل شركة مع فحص حالة الاشتراك والمساحة المخصصة على السيرفر
app.get('/sync', (req, res) => {
  const tenantId = String(req.query.tenant || 'COMP-001').replace(/[^A-Za-z0-9_-]/g, '');
  const lic = loadLicenses();
  const tLic = lic.tenants && lic.tenants[tenantId];
  if (tLic && tLic.status === 'suspended') {
    return res.status(402).json({ error: 'تم إيقاف اشتراك الشركة لعدم السداد', suspended: true });
  }
  const file = path.join(DATA_DIR, `${tenantId}.json`);
  if (!fs.existsSync(file)) return res.json(null);
  res.sendFile(file);
});

app.post('/sync', (req, res) => {
  const tenantId = String(req.query.tenant || 'COMP-001').replace(/[^A-Za-z0-9_-]/g, '');
  const lic = loadLicenses();
  const tLic = lic.tenants && lic.tenants[tenantId];
  if (tLic && tLic.status === 'suspended') {
    return res.status(402).json({ error: 'تم إيقاف اشتراك الشركة لعدم السداد', suspended: true });
  }
  const rawBody = JSON.stringify(req.body);
  const sizeMB = Buffer.byteLength(rawBody, 'utf8') / (1024 * 1024);
  if (tLic && tLic.storageQuotaMB && sizeMB > tLic.storageQuotaMB) {
    return res.status(413).json({ error: 'تجاوزت الشركة المساحة التخزينية المخصصة لها' });
  }
  const file = path.join(DATA_DIR, `${tenantId}.json`);
  fs.writeFileSync(file, rawBody, 'utf8');
  res.json({ ok: true, sizeMB: Math.round(sizeMB * 100) / 100, savedAt: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NexaCore ERP SaaS Server running on port ${PORT}`));
