# WA Broadcast

Dashboard web untuk mengirim pesan dari **WhatsApp Business** ke daftar kontak, memakai **WhatsApp Cloud API resmi dari Meta** (aman dari blokir karena tidak memakai cara tidak resmi).

## Fitur

- **Impor kontak** dari file `.vcf` (ekspor kontak HP) atau `.csv` (Google Contacts / Excel). Nomor `08xx` otomatis diubah ke `628xx`.
- **Tag/grup kontak** untuk mengirim ke kelompok tertentu (mis. `pelanggan`, `grosir`).
- **Kirim pesan template** (disetujui Meta) dengan personalisasi `{nama}`, termasuk header gambar.
- **Kirim teks bebas** ke kontak yang chat Anda dalam 24 jam terakhir.
- **Antrean dengan jeda** antar pesan supaya tidak kena rate limit.
- **Riwayat & status**: Antre → Terkirim → Diterima → Dibaca / Gagal (lewat webhook).
- **Opt-out otomatis**: kontak yang membalas `STOP` / `BERHENTI` tidak akan dikirimi lagi.
- Dashboard dilindungi password.

## Penting: aturan WhatsApp

1. **API tidak bisa membaca kontak di HP.** Ekspor kontak dari HP (Kontak → Ekspor → file `.vcf`) lalu impor di dashboard.
2. **Pesan pertama ke pelanggan wajib memakai template** yang sudah disetujui Meta (buat di WhatsApp Manager). Teks bebas hanya bisa ke kontak yang chat Anda dalam 24 jam terakhir.
3. **Ada biaya per pesan template** (kategori Marketing/Utility/Authentication), ditagih Meta.
4. Kirim hanya ke orang yang **setuju menerima pesan** dari bisnis Anda. Terlalu banyak laporan spam akan menurunkan kualitas nomor dan batas kirim.
5. Nomor yang didaftarkan ke Cloud API **tidak bisa dipakai bersamaan di aplikasi WhatsApp Business di HP** (kecuali memakai fitur *coexistence* dari Meta, jika tersedia untuk nomor Anda).

## Langkah setup

### 1. Siapkan akun Meta
1. Buka <https://developers.facebook.com> → **My Apps** → **Create App** → pilih tipe **Business**.
2. Tambahkan produk **WhatsApp** ke app.
3. Di **WhatsApp → API Setup**, catat:
   - **Phone number ID** → `WA_PHONE_NUMBER_ID`
   - **WhatsApp Business Account ID** → `WA_WABA_ID`
4. Tambahkan dan verifikasi nomor bisnis Anda (atau pakai nomor tes dulu).
5. Buat **access token permanen**: Business Settings → **System Users** → buat system user (Admin) → **Generate token** dengan izin `whatsapp_business_messaging` dan `whatsapp_business_management` → `WA_TOKEN`.
6. Catat **App Secret** (App → Settings → Basic) → `APP_SECRET`.

### 2. Buat template pesan
WhatsApp Manager → **Message Templates** → **Create**. Contoh isi:
```
Halo {{1}}, ada promo spesial minggu ini di toko kami! Balas STOP jika tidak ingin menerima pesan lagi.
```
Tunggu sampai statusnya **Approved**.

### 3. Jalankan aplikasi
Butuh **Node.js 18+**.
```bash
npm install
```
```bash
cp .env.example .env
```
Edit `.env`, isi semua nilainya (terutama `DASHBOARD_PASSWORD`), lalu:
```bash
npm start
```
Buka <http://localhost:3000>, lalu masuk dengan password dari `.env` (`DASHBOARD_PASSWORD`).

Mau mencoba tanpa mengirim sungguhan? Set `DRY_RUN=true`.

### 4. Pasang webhook (untuk status & opt-out)
Webhook butuh alamat **HTTPS publik**. Pilihannya: deploy ke server/VPS (Railway, Render, VPS dengan Nginx + SSL), atau saat uji coba pakai tunnel seperti `cloudflared` / `ngrok`.

Di Meta App → **WhatsApp → Configuration → Webhook**:
- **Callback URL**: `https://domain-anda/webhook`
- **Verify token**: isi sama dengan `WEBHOOK_VERIFY_TOKEN`
- Subscribe ke field **messages**.

## Format file impor

**CSV** (pemisah `,` atau `;`, baris pertama judul kolom):
```csv
nama,nomor,tag
Budi,081234567890,pelanggan
Ani,+62 857 1111 2222,"pelanggan,vip"
```
Ekspor dari Google Contacts juga langsung bisa dibaca.

**VCF**: file hasil ekspor kontak dari Android/iPhone.

## Struktur

```
server.js          Server Express: API, antrean kirim, webhook
lib/whatsapp.js    Klien WhatsApp Cloud API
lib/db.js          Penyimpanan JSON (data/db.json)
public/            Dashboard (HTML/CSS/JS)
```

Data kontak dan riwayat tersimpan di `data/db.json`. Backup file ini secara berkala.
