require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./lib/db');
const wa = require('./lib/whatsapp');

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS || 1200);

if (!PASSWORD || PASSWORD === 'ganti_password_ini') {
  console.warn('[PERINGATAN] DASHBOARD_PASSWORD belum diganti. Set di file .env sebelum dipakai.');
}

const app = express();

// ---------- Webhook (harus sebelum express.json agar raw body tersedia) ----------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const secret = process.env.APP_SECRET;
  if (secret) {
    const sig = req.get('x-hub-signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    const ok = sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!ok) return res.sendStatus(401);
  }
  res.sendStatus(200); // balas cepat ke Meta
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return; }
  handleWebhook(payload);
});

function handleWebhook(payload) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      for (const st of v.statuses || []) {
        db.updateMessageByWamid(st.id, {
          status: st.status,
          error: st.errors ? st.errors.map(e => `${e.code}: ${e.title}`).join('; ') : undefined,
        });
      }
      for (const msg of v.messages || []) {
        const text = (msg.text && msg.text.body || '').trim().toUpperCase();
        db.markInbound(msg.from);
        if (['STOP', 'BERHENTI', 'UNSUBSCRIBE'].includes(text)) {
          db.setOptOut(msg.from, true);
        }
      }
    }
  }
}

// ---------- Login dashboard (cookie bertanda tangan) ----------
const SESSION_KEY = crypto.createHash('sha256').update('wa-broadcast:' + PASSWORD).digest();
const SESSION_DAYS = 7;

function makeSession() {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const sig = crypto.createHmac('sha256', SESSION_KEY).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
}
function validSession(token) {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', SESSION_KEY).update(exp).digest('hex');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
function getCookie(req, name) {
  const m = (req.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function passwordOk(input) {
  const a = Buffer.from(String(input || '')), b = Buffer.from(PASSWORD);
  return Boolean(PASSWORD) && a.length === b.length && crypto.timingSafeEqual(a, b);
}

const loginAttempts = new Map(); // ip -> { count, until }
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'public', 'style.css')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const ip = req.ip;
  const a = loginAttempts.get(ip) || { count: 0, until: 0 };
  if (a.until > Date.now()) return res.redirect('/login?err=wait');
  if (!passwordOk(req.body && req.body.password)) {
    a.count++;
    if (a.count >= 5) { a.until = Date.now() + 5 * 60e3; a.count = 0; }
    loginAttempts.set(ip, a);
    return res.redirect('/login?err=1');
  }
  loginAttempts.delete(ip);
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.set('Set-Cookie', `wa_session=${makeSession()}; Path=/; HttpOnly; Max-Age=${SESSION_DAYS * 86400}; ` +
    (secure ? 'Secure; SameSite=None' : 'SameSite=Lax'));
  res.redirect('/');
});
app.post('/logout', (req, res) => {
  res.set('Set-Cookie', 'wa_session=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/login');
});

app.use((req, res, next) => {
  if (validSession(getCookie(req, 'wa_session'))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sesi berakhir, silakan login ulang' });
  res.redirect('/login');
});

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- API ----------
app.get('/api/status', (req, res) => {
  res.json({ configured: wa.isConfigured(), dryRun: wa.isDryRun(), sending: queue.running, queued: queue.items.length });
});

app.get('/api/contacts', (req, res) => res.json(db.listContacts()));

app.post('/api/contacts', (req, res) => {
  const { name, phone, tags } = req.body || {};
  const normalized = wa.normalizePhone(phone);
  if (!normalized) return res.status(400).json({ error: 'Nomor tidak valid' });
  res.json(db.upsertContact({ name: String(name || '').trim(), phone: normalized, tags: parseTags(tags) }));
});

app.post('/api/contacts/import', (req, res) => {
  const rows = Array.isArray(req.body && req.body.contacts) ? req.body.contacts : [];
  let added = 0, invalid = [];
  for (const r of rows) {
    const phone = wa.normalizePhone(r.phone);
    if (!phone) { invalid.push(r.phone); continue; }
    db.upsertContact({ name: String(r.name || '').trim(), phone, tags: parseTags(r.tags) });
    added++;
  }
  res.json({ added, invalid });
});

app.patch('/api/contacts/:id', (req, res) => {
  const c = db.updateContact(req.params.id, req.body || {});
  if (!c) return res.status(404).json({ error: 'Kontak tidak ditemukan' });
  res.json(c);
});

app.delete('/api/contacts/:id', (req, res) => {
  db.deleteContact(req.params.id);
  res.json({ ok: true });
});

app.get('/api/templates', async (req, res) => {
  try { res.json(await wa.listTemplates()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/messages', (req, res) => res.json(db.listMessages(500)));

app.post('/api/send', (req, res) => {
  const { contactIds, mode, template, text } = req.body || {};
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return res.status(400).json({ error: 'Pilih minimal satu kontak' });
  }
  if (mode === 'template' && !(template && template.name && template.language)) {
    return res.status(400).json({ error: 'Template belum dipilih' });
  }
  if (mode === 'text' && !String(text || '').trim()) {
    return res.status(400).json({ error: 'Pesan kosong' });
  }
  if (!['template', 'text'].includes(mode)) return res.status(400).json({ error: 'Mode tidak dikenal' });

  const batchId = crypto.randomUUID();
  let skipped = 0, queued = 0;
  for (const id of contactIds) {
    const c = db.getContact(id);
    if (!c) continue;
    if (c.optOut) { skipped++; continue; }
    const m = db.addMessage({ batchId, contactId: c.id, phone: c.phone, name: c.name, mode,
      summary: mode === 'template' ? `Template: ${template.name}` : String(text).slice(0, 200), status: 'queued' });
    queue.items.push({ messageId: m.id, contact: c, mode, template, text });
    queued++;
  }
  runQueue();
  res.json({ batchId, queued, skipped });
});

// ---------- Antrian pengiriman ----------
const queue = { items: [], running: false };

async function runQueue() {
  if (queue.running) return;
  queue.running = true;
  try {
    while (queue.items.length) {
      const job = queue.items.shift();
      try {
        const wamid = job.mode === 'template'
          ? await wa.sendTemplate(job.contact.phone, job.template, job.contact)
          : await wa.sendText(job.contact.phone, wa.personalize(job.text, job.contact));
        db.updateMessage(job.messageId, { status: 'sent', wamid });
      } catch (e) {
        db.updateMessage(job.messageId, { status: 'failed', error: e.message });
      }
      if (queue.items.length) await new Promise(r => setTimeout(r, SEND_DELAY_MS));
    }
  } finally {
    queue.running = false;
  }
}

function parseTags(t) {
  if (Array.isArray(t)) return t.map(s => String(s).trim()).filter(Boolean);
  return String(t || '').split(/[,;|]/).map(s => s.trim()).filter(Boolean);
}

app.listen(PORT, () => {
  console.log(`WA Broadcast berjalan di http://localhost:${PORT}`);
  if (!wa.isConfigured()) console.log('Kredensial WhatsApp belum lengkap. Isi file .env (lihat .env.example).');
  if (wa.isDryRun()) console.log('DRY_RUN aktif: pesan tidak benar-benar dikirim.');
});
