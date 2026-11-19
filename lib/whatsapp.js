// Klien WhatsApp Cloud API (resmi dari Meta).
const GRAPH = () => `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v23.0'}`;

const isDryRun = () => String(process.env.DRY_RUN).toLowerCase() === 'true';
const isConfigured = () => Boolean(process.env.WA_TOKEN && process.env.WA_PHONE_NUMBER_ID && process.env.WA_WABA_ID);

// Ubah nomor ke format internasional tanpa "+" (mis. 08123... -> 628123...).
function normalizePhone(input) {
  let p = String(input || '').replace(/[^\d+]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) p = p.slice(1);
  else if (p.startsWith('00')) p = p.slice(2);
  else if (p.startsWith('0')) p = '62' + p.slice(1); // default Indonesia
  else if (p.startsWith('8') && p.length >= 9 && p.length <= 13) p = '62' + p;
  p = p.replace(/\D/g, '');
  return p.length >= 8 && p.length <= 15 ? p : null;
}

// Ganti {nama} dan {nomor} dengan data kontak.
function personalize(str, contact) {
  return String(str || '')
    .replace(/\{nama\}/gi, contact.name || '')
    .replace(/\{nomor\}/gi, contact.phone || '');
}

async function graph(pathname, { method = 'GET', body } = {}) {
  if (!isConfigured()) throw new Error('Kredensial WhatsApp belum diisi di .env');
  const res = await fetch(`${GRAPH()}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = data.error || {};
    throw new Error(`${err.code || res.status}: ${err.error_user_msg || err.message || 'Permintaan gagal'}`);
  }
  return data;
}

async function listTemplates() {
  if (isDryRun() && !isConfigured()) {
    return [{ name: 'hello_world', language: 'en_US', category: 'UTILITY', bodyText: 'Hello World', bodyParams: [], headerFormat: null }];
  }
  const out = [];
  let url = `/${process.env.WA_WABA_ID}/message_templates?status=APPROVED&limit=100&fields=name,language,category,components,status`;
  while (url) {
    const data = await graph(url);
    for (const t of data.data || []) {
      const body = (t.components || []).find(c => c.type === 'BODY');
      const header = (t.components || []).find(c => c.type === 'HEADER');
      const bodyText = body ? body.text : '';
      const names = [...new Set((bodyText.match(/\{\{\s*([^}]+?)\s*\}\}/g) || [])
        .map(m => m.replace(/[{}\s]/g, '')))];
      out.push({
        name: t.name,
        language: t.language,
        category: t.category,
        bodyText,
        bodyParams: names, // mis. ["1","2"] atau ["nama_pelanggan"]
        headerFormat: header ? header.format : null,
        headerText: header && header.format === 'TEXT' ? header.text : null,
      });
    }
    const next = data.paging && data.paging.next;
    url = next ? next.replace(GRAPH(), '') : null;
  }
  return out;
}

// template = { name, language, params: [{ name: "1", value: "teks {nama}" }, ...], headerImage?: url }
async function sendTemplate(to, template, contact) {
  const components = [];
  if (template.headerImage) {
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: template.headerImage } }] });
  }
  if (Array.isArray(template.params) && template.params.length) {
    components.push({
      type: 'body',
      parameters: template.params.map(p => ({
        type: 'text',
        text: personalize(p.value, contact) || '-',
        // template dengan variabel bernama ({{nama_pelanggan}}) wajib menyertakan parameter_name
        ...(/^\d+$/.test(p.name) ? {} : { parameter_name: p.name }),
      })),
    });
  }
  return send({
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name: template.name, language: { code: template.language }, ...(components.length ? { components } : {}) },
  });
}

async function sendText(to, text) {
  return send({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: true } });
}

async function send(body) {
  if (isDryRun()) {
    console.log('[DRY_RUN] kirim:', JSON.stringify(body));
    return 'dryrun.' + Date.now() + Math.random().toString(36).slice(2, 8);
  }
  const data = await graph(`/${process.env.WA_PHONE_NUMBER_ID}/messages`, { method: 'POST', body });
  return data.messages && data.messages[0] && data.messages[0].id;
}

module.exports = { normalizePhone, personalize, listTemplates, sendTemplate, sendText, isConfigured, isDryRun };
