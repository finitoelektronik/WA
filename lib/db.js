// Penyimpanan sederhana berbasis file JSON (cukup untuk ribuan kontak).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'db.json');
let state = { contacts: [], messages: [] };

try {
  state = { ...state, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch (e) {
  if (e.code !== 'ENOENT') console.error('Gagal membaca database:', e.message);
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  }, 200);
}

const now = () => new Date().toISOString();

module.exports = {
  listContacts: () => [...state.contacts].sort((a, b) => (a.name || '').localeCompare(b.name || '')),
  getContact: id => state.contacts.find(c => c.id === id),

  upsertContact({ name, phone, tags = [] }) {
    let c = state.contacts.find(x => x.phone === phone);
    if (c) {
      if (name) c.name = name;
      c.tags = Array.from(new Set([...(c.tags || []), ...tags]));
      c.updatedAt = now();
    } else {
      c = { id: crypto.randomUUID(), name, phone, tags, optOut: false, lastInboundAt: null, createdAt: now() };
      state.contacts.push(c);
    }
    save();
    return c;
  },

  updateContact(id, patch) {
    const c = state.contacts.find(x => x.id === id);
    if (!c) return null;
    if (typeof patch.name === 'string') c.name = patch.name.trim();
    if (typeof patch.optOut === 'boolean') c.optOut = patch.optOut;
    if (Array.isArray(patch.tags)) c.tags = patch.tags;
    c.updatedAt = now();
    save();
    return c;
  },

  deleteContact(id) {
    state.contacts = state.contacts.filter(c => c.id !== id);
    save();
  },

  setOptOut(phone, value) {
    const c = state.contacts.find(x => x.phone === phone);
    if (c) { c.optOut = value; c.updatedAt = now(); save(); }
  },

  markInbound(phone) {
    const c = state.contacts.find(x => x.phone === phone);
    if (c) { c.lastInboundAt = now(); save(); }
  },

  addMessage(m) {
    const msg = { id: crypto.randomUUID(), createdAt: now(), ...m };
    state.messages.push(msg);
    if (state.messages.length > 20000) state.messages.splice(0, state.messages.length - 20000);
    save();
    return msg;
  },

  updateMessage(id, patch) {
    const m = state.messages.find(x => x.id === id);
    if (m) { Object.assign(m, clean(patch), { updatedAt: now() }); save(); }
  },

  updateMessageByWamid(wamid, patch) {
    const m = state.messages.find(x => x.wamid === wamid);
    if (!m) return;
    // jangan turunkan status (mis. "read" -> "delivered" yang datang terlambat)
    const rank = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };
    if (patch.status && (rank[patch.status] ?? 0) < (rank[m.status] ?? 0)) delete patch.status;
    Object.assign(m, clean(patch), { updatedAt: now() });
    save();
  },

  listMessages: limit => state.messages.slice(-limit).reverse(),
};

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
