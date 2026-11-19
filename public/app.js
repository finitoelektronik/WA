const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let contacts = [];
let templates = [];
const selected = new Set();

async function api(url, opts = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401) { location.href = '/login'; throw new Error('Sesi berakhir'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- Tab ----------
document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
  if (btn.dataset.tab === 'history') loadHistory();
  if (btn.dataset.tab === 'send') renderRecipients();
}));

async function loadStatus() {
  try {
    const s = await api('/api/status');
    const b = $('#status-badge');
    b.textContent = s.dryRun ? 'Mode uji (DRY_RUN)' : s.configured ? 'Terhubung ke WhatsApp API' : 'Kredensial belum diisi';
    if (s.sending) b.textContent += ` · mengirim (${s.queued} antre)`;
  } catch { /* abaikan */ }
}

// ---------- Kontak ----------
async function loadContacts() {
  contacts = await api('/api/contacts');
  for (const id of [...selected]) if (!contacts.find(c => c.id === id)) selected.delete(id);
  renderContacts();
  renderTagOptions();
  renderRecipients();
}

function matches(c, q, tag) {
  q = q.trim().toLowerCase();
  if (tag && !(c.tags || []).includes(tag)) return false;
  if (!q) return true;
  return (c.name || '').toLowerCase().includes(q) || c.phone.includes(q.replace(/\D/g, '') || '\u0000') ||
    (c.tags || []).some(t => t.toLowerCase().includes(q));
}

function renderContacts() {
  const q = $('#contact-search').value;
  const list = contacts.filter(c => matches(c, q, ''));
  $('#contact-count').textContent = `(${contacts.length})`;
  $('#contact-rows').innerHTML = list.map(c => `
    <tr>
      <td>${esc(c.name) || '<span class="muted">—</span>'}</td>
      <td>+${esc(c.phone)}</td>
      <td>${(c.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</td>
      <td>${c.optOut ? '<span class="st st-optout">Opt-out</span>' : '<span class="st st-delivered">Aktif</span>'}</td>
      <td style="white-space:nowrap">
        <button class="link" style="color:inherit" data-toggle="${c.id}">${c.optOut ? 'Aktifkan' : 'Opt-out'}</button>
        <button class="link" data-del="${c.id}">Hapus</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">Belum ada kontak.</td></tr>';
}

$('#contact-rows').addEventListener('click', async e => {
  const del = e.target.dataset.del, tog = e.target.dataset.toggle;
  if (del && confirm('Hapus kontak ini?')) { await api('/api/contacts/' + del, { method: 'DELETE' }); loadContacts(); }
  if (tog) {
    const c = contacts.find(x => x.id === tog);
    await api('/api/contacts/' + tog, { method: 'PATCH', body: { optOut: !c.optOut } });
    loadContacts();
  }
});
$('#contact-search').addEventListener('input', renderContacts);

$('#add-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/api/contacts', { method: 'POST', body: Object.fromEntries(f) });
    e.target.reset();
    loadContacts();
  } catch (err) { alert(err.message); }
});

// ---------- Impor CSV / VCF ----------
$('#import-btn').addEventListener('click', async () => {
  const file = $('#import-file').files[0];
  if (!file) return alert('Pilih file dulu');
  const text = await file.text();
  const extraTag = $('#import-tag').value.trim();
  let rows = /BEGIN:VCARD/i.test(text) ? parseVcf(text, $('#import-note-tag').checked) : parseCsv(text);
  if (extraTag) rows = rows.map(r => ({ ...r, tags: [r.tags, extraTag].filter(Boolean).join(',') }));
  if (!rows.length) return ($('#import-result').textContent = 'Tidak ada nomor yang ditemukan di file.');
  try {
    const r = await api('/api/contacts/import', { method: 'POST', body: { contacts: rows } });
    $('#import-result').textContent = `${r.added} kontak diimpor.` + (r.invalid.length ? ` ${r.invalid.length} nomor tidak valid dilewati.` : '');
    $('#import-file').value = '';
    loadContacts();
  } catch (err) { $('#import-result').textContent = 'Gagal: ' + err.message; }
});

function parseVcf(text, useNoteAsTag = false) {
  const rows = [];
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  for (const card of unfolded.split(/BEGIN:VCARD/i).slice(1)) {
    const lines = card.split(/\r?\n/);
    let name = '', note = '';
    const phones = [], tags = [];
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).toUpperCase(), val = line.slice(idx + 1).trim();
      if (key.startsWith('FN')) name = decodeVcfValue(key, val);
      else if (!name && key.startsWith('N') && !key.startsWith('NOTE') && !key.startsWith('NICKNAME')) {
        name = decodeVcfValue(key, val).split(';').filter(Boolean).reverse().join(' ');
      } else if (key.startsWith('TEL') || /\.TEL/.test(key)) phones.push(val);
      else if (key.startsWith('CATEGORIES')) tags.push(...decodeVcfValue(key, val).split(','));
      else if (key.startsWith('NOTE')) note = decodeVcfValue(key, val).trim();
    }
    // Opsi: pakai catatan sebagai tag. "Prospek Toko - Semarang" -> tag "Semarang"
    if (useNoteAsTag && note) tags.push(note.includes(' - ') ? note.split(' - ').pop() : note);
    const tagStr = tags.map(t => t.trim()).filter(t => t && !/^mycontacts$/i.test(t)).join(',');
    for (const p of phones) rows.push({ name, phone: p, tags: tagStr });
  }
  return rows;
}

function decodeVcfValue(key, val) {
  if (/ENCODING=QUOTED-PRINTABLE/.test(key)) {
    try {
      const bytes = val.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      return decodeURIComponent(escape(bytes));
    } catch { return val; }
  }
  return val.replace(/\\,/g, ',').replace(/\\;/g, ';');
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const delim = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const data = rows.filter(r => r.some(c => c.trim()));
  if (!data.length) return [];

  const header = data[0].map(h => h.trim().toLowerCase());
  const find = re => header.findIndex(h => re.test(h));
  let iName = find(/^(nama|name|full name|display name)$/);
  const iFirst = find(/^(first name|given name|nama depan)$/), iLast = find(/^(last name|family name|nama belakang)$/);
  let iPhone = find(/^(nomor|no|no hp|no\. hp|hp|phone|telepon|whatsapp|wa|mobile|nomor hp|phone 1 - value)$/);
  if (iPhone < 0) iPhone = find(/phone|telepon|nomor|mobile|hp/);
  const iTags = find(/^(tag|tags|label|labels|grup|group|group membership)$/);

  let body = data.slice(1);
  if (iPhone < 0) { // tanpa header: anggap kolom 1 = nama, 2 = nomor
    body = data; iName = 0; iPhone = 1;
  }
  return body.map(r => {
    let name = iName >= 0 ? r[iName] : [r[iFirst], r[iLast]].filter(Boolean).join(' ');
    const tags = iTags >= 0 ? (r[iTags] || '').replace(/\* myContacts/gi, '').replace(/:::/g, ',') : '';
    // Google Contacts bisa berisi beberapa nomor dalam satu sel dipisah " ::: "
    return String(r[iPhone] || '').split(/:::/).map(p => ({ name: (name || '').trim(), phone: p.trim(), tags }));
  }).flat().filter(r => r.phone);
}

// ---------- Penerima ----------
function renderTagOptions() {
  const tags = [...new Set(contacts.flatMap(c => c.tags || []))].sort();
  const sel = $('#recipient-tag'), cur = sel.value;
  sel.innerHTML = '<option value="">Semua tag</option>' + tags.map(t => `<option ${t === cur ? 'selected' : ''}>${esc(t)}</option>`).join('');
}

function filteredRecipients() {
  return contacts.filter(c => matches(c, $('#recipient-search').value, $('#recipient-tag').value));
}

function renderRecipients() {
  const list = filteredRecipients();
  $('#recipient-list').innerHTML = list.map(c => `
    <label class="${c.optOut ? 'disabled' : ''}">
      <input type="checkbox" value="${c.id}" ${selected.has(c.id) ? 'checked' : ''} ${c.optOut ? 'disabled' : ''}>
      <span>${esc(c.name) || '—'} <span class="muted">+${esc(c.phone)}</span>
      ${(c.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
      ${c.optOut ? '<span class="st st-optout">opt-out</span>' : ''}</span>
    </label>`).join('') || '<div class="hint" style="padding:10px">Tidak ada kontak.</div>';
  $('#selected-count').textContent = selected.size;
}

$('#recipient-list').addEventListener('change', e => {
  if (e.target.type !== 'checkbox') return;
  e.target.checked ? selected.add(e.target.value) : selected.delete(e.target.value);
  $('#selected-count').textContent = selected.size;
});
$('#recipient-search').addEventListener('input', renderRecipients);
$('#recipient-tag').addEventListener('change', renderRecipients);
$('#select-all').addEventListener('click', () => { filteredRecipients().filter(c => !c.optOut).forEach(c => selected.add(c.id)); renderRecipients(); });
$('#select-none').addEventListener('click', () => { selected.clear(); renderRecipients(); });

// ---------- Template ----------
document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', () => {
  const mode = document.querySelector('input[name=mode]:checked').value;
  $('#mode-template').hidden = mode !== 'template';
  $('#mode-text').hidden = mode !== 'text';
}));

async function loadTemplates() {
  const sel = $('#template-select');
  sel.innerHTML = '<option value="">Memuat template…</option>';
  try {
    templates = await api('/api/templates');
    sel.innerHTML = '<option value="">— Pilih template —</option>' + templates.map((t, i) =>
      `<option value="${i}">${esc(t.name)} (${esc(t.language)}, ${esc(t.category)})</option>`).join('');
    if (!templates.length) sel.innerHTML = '<option value="">Belum ada template yang disetujui</option>';
  } catch (e) {
    sel.innerHTML = `<option value="">Gagal memuat: ${esc(e.message)}</option>`;
  }
  renderTemplate();
}

function renderTemplate() {
  const t = templates[$('#template-select').value];
  $('#template-preview').textContent = t ? [t.headerText, t.bodyText].filter(Boolean).join('\n\n') : '';
  $('#template-header-wrap').hidden = !(t && t.headerFormat === 'IMAGE');
  $('#template-params').innerHTML = t ? t.bodyParams.map(p =>
    `<label>Variabel {{${esc(p)}}} <input type="text" data-param="${esc(p)}" placeholder="mis. {nama}"></label>`).join('') : '';
}
$('#template-select').addEventListener('change', renderTemplate);
$('#reload-templates').addEventListener('click', loadTemplates);

// ---------- Kirim ----------
$('#send-btn').addEventListener('click', async () => {
  const mode = document.querySelector('input[name=mode]:checked').value;
  const body = { contactIds: [...selected], mode };
  if (mode === 'template') {
    const t = templates[$('#template-select').value];
    if (!t) return alert('Pilih template dulu');
    body.template = {
      name: t.name, language: t.language,
      params: [...document.querySelectorAll('[data-param]')].map(i => ({ name: i.dataset.param, value: i.value })),
      headerImage: t.headerFormat === 'IMAGE' ? $('#template-header-image').value.trim() : undefined,
    };
    if (body.template.params.some(p => !p.value.trim())) return alert('Semua variabel template wajib diisi');
    if (t.headerFormat === 'IMAGE' && !body.template.headerImage) return alert('Isi URL gambar header');
  } else {
    body.text = $('#text-body').value;
  }
  if (!body.contactIds.length) return alert('Pilih penerima dulu');
  if (!confirm(`Kirim pesan ke ${body.contactIds.length} kontak?`)) return;

  const btn = $('#send-btn');
  btn.disabled = true;
  try {
    const r = await api('/api/send', { method: 'POST', body });
    $('#send-result').textContent = `${r.queued} pesan masuk antrean.` + (r.skipped ? ` ${r.skipped} dilewati (opt-out).` : '') + ' Lihat tab Riwayat untuk status.';
  } catch (e) {
    $('#send-result').textContent = 'Gagal: ' + e.message;
  } finally {
    btn.disabled = false;
    loadStatus();
  }
});

// ---------- Riwayat ----------
const STATUS_LABEL = { queued: 'Antre', sent: 'Terkirim', delivered: 'Diterima', read: 'Dibaca', failed: 'Gagal' };

async function loadHistory() {
  const msgs = await api('/api/messages');
  const count = s => msgs.filter(m => m.status === s).length;
  $('#history-summary').innerHTML = Object.entries(STATUS_LABEL)
    .map(([k, v]) => `<span><span class="st st-${k}">${v}</span>: ${count(k)}</span>`).join('');
  $('#history-rows').innerHTML = msgs.map(m => `
    <tr>
      <td style="white-space:nowrap">${new Date(m.createdAt).toLocaleString('id-ID')}</td>
      <td>${esc(m.name) || '—'}<br><span class="muted">+${esc(m.phone)}</span></td>
      <td>${esc(m.summary)}</td>
      <td><span class="st st-${esc(m.status)}">${STATUS_LABEL[m.status] || esc(m.status)}</span>
        ${m.error ? `<div class="err">${esc(m.error)}</div>` : ''}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">Belum ada pengiriman.</td></tr>';
}
$('#refresh-history').addEventListener('click', loadHistory);

setInterval(() => {
  loadStatus();
  if ($('#tab-history').classList.contains('active')) loadHistory();
}, 5000);

loadStatus();
loadContacts();
loadTemplates();
