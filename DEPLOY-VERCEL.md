# Panduan Deploy DomainWatch ke Vercel (untuk pemula)

Panduan ini ditulis untuk Anda yang belum pernah coding atau deploy. Semua langkah dilakukan lewat website (GitHub, Supabase, Vercel, Telegram). Tidak perlu terminal.

> **Aturan penting:** jangan pernah menempelkan kunci rahasia (secret key, token, kata sandi) ke chat, email, atau dokumen. Masukkan hanya ke tempat yang disebutkan di panduan ini.

Istilah singkat:

- **Repository (repo):** folder kode di GitHub.
- **Deploy:** memasang aplikasi di internet supaya bisa dibuka lewat alamat web.
- **Environment variable:** pengaturan rahasia/konfigurasi yang disimpan di Vercel, bukan di kode.
- **Migration / skema database:** perintah SQL yang membuat tabel-tabel di database.

---

## Langkah 1 — Siapkan akun

Anda butuh tiga akun gratis (lewati yang sudah punya):

1. **GitHub** — https://github.com/signup (Anda sudah punya: `annadmin-cyber`).
2. **Supabase** — https://supabase.com/dashboard/sign-up. Paling mudah pilih "Continue with GitHub".
3. **Vercel** — https://vercel.com/signup. Pilih paket **Hobby** (gratis) lalu "Continue with GitHub".

## Langkah 2 — Kode di GitHub

Kode sudah dikirim ke repository https://github.com/annadmin-cyber/DomainWatch dalam sebuah *Pull Request*. Pull Request adalah usulan perubahan yang perlu Anda setujui.

1. Buka tab **Pull requests** di repository.
2. Klik pull request DomainWatch.
3. Klik tombol hijau **Merge pull request**, lalu **Confirm merge**.
4. Buka tab **Code**; Anda akan melihat folder `src`, `supabase`, dan file `vercel.json`.

(Jika suatu hari Anda harus mengunggah manual: di halaman repo klik **Add file > Upload files**, seret semua isi ZIP kecuali folder `node_modules` dan `.next`, lalu **Commit changes**.)

## Langkah 3 — Buat proyek Supabase

1. Buka https://supabase.com/dashboard, klik **New project**.
2. Isi:
   - **Name:** `domainwatch`
   - **Database Password:** klik **Generate a password**, lalu simpan di pengelola kata sandi Anda (jangan kirim ke chat).
   - **Region:** pilih **Southeast Asia (Singapore)**.
   - Plan: **Free**.
3. Klik **Create new project** dan tunggu 1–2 menit sampai selesai.

## Langkah 4 — Pasang skema database dan aturan akses

Folder `supabase/migrations/` berisi file SQL bernomor. Jalankan **semuanya, berurutan** (`0001_init.sql`, lalu `0002_hardening.sql`, dan seterusnya jika nanti ada file baru). Untuk setiap file:

1. Di GitHub, buka file tersebut, klik ikon **Copy raw file** (dua kotak bertumpuk) di kanan atas isi file.
2. Di Supabase, menu kiri: **SQL Editor** > **New query**.
3. Tempel (Ctrl+V / Cmd+V) seluruh isi, lalu klik **Run**.
4. Hasil yang diharapkan: **"Success. No rows returned"**. Jika muncul peringatan tentang operasi berbahaya ("destructive operation"), itu karena ada perintah `drop ... if exists`; klik **Run this query** untuk melanjutkan.

Semua file aman dijalankan ulang. Cek: menu **Table Editor** sekarang berisi tabel `domains`, `monitored_domains`, `notifications`, dan lainnya.

## Langkah 5 — Buat akun login pemilik

1. Supabase > **Authentication** > **Users** > **Add user** > **Create new user**.
2. Isi email Anda dan kata sandi yang kuat. **Centang "Auto Confirm User"**. Klik **Create user**.
3. Matikan pendaftaran publik supaya orang lain tidak bisa membuat akun: **Authentication** > **Sign In / Providers** (atau **Providers**) > matikan **Allow new users to sign up** > **Save**.
4. Daftarkan akun itu sebagai pemilik:
   - Di GitHub buka `supabase/setup-owner.sql`, salin isinya.
   - Supabase > **SQL Editor** > **New query**, tempel.
   - Ganti `owner@example.com` dengan email Anda (tetap di dalam tanda kutip).
   - Klik **Run**. Hasil yang diharapkan: satu baris berisi email Anda.

## Langkah 6 — Impor repository ke Vercel

1. Buka https://vercel.com/new.
2. Di bagian **Import Git Repository**, pilih `DomainWatch` (jika tidak muncul, klik **Adjust GitHub App Permissions** dan izinkan repo ini).
3. Klik **Import**. **Jangan klik Deploy dulu**; lanjut ke Langkah 7 di halaman yang sama.

## Langkah 7 — Isi environment variables

Di halaman impor Vercel, buka bagian **Environment Variables**. Tambahkan satu per satu (Key = nama, Value = nilai):

| Nama (Key) | Dari mana nilainya | Rahasia? |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase > **Project Settings** > **Data API** > **Project URL** (contoh `https://abcd.supabase.co`) | Tidak |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase > **Project Settings** > **API Keys** > **Publishable key** (diawali `sb_publishable_`) | Tidak |
| `SUPABASE_SECRET_KEY` | Supabase > **Project Settings** > **API Keys** > **Secret keys** > salin (diawali `sb_secret_`) | **Ya** |
| `CRON_SECRET` | Buat sendiri: teks acak minimal 16 karakter, misalnya dari pembuat kata sandi di pengelola kata sandi Anda (huruf dan angka saja) | **Ya** |
| `TELEGRAM_BOT_TOKEN` | Opsional, lihat Langkah 13. Boleh dikosongkan dulu. | **Ya** |

Salin nilai langsung dari Supabase ke Vercel. Jangan menempelkannya di chat.

## Langkah 8 — Deploy

1. Klik **Deploy**. Tunggu sampai muncul "Congratulations" (sekitar 1–3 menit).
2. Klik **Continue to Dashboard**. Alamat aplikasi Anda tertera di **Domains**, misalnya `https://domainwatch-xxxx.vercel.app`.

Jika environment variable baru ditambahkan atau diubah setelah deploy: **Deployments** > titik tiga di deployment teratas > **Redeploy**.

## Langkah 9 — Atur URL autentikasi Supabase

1. Supabase > **Authentication** > **URL Configuration**.
2. **Site URL:** isi alamat Vercel Anda, misalnya `https://domainwatch-xxxx.vercel.app`.
3. **Redirect URLs:** klik **Add URL**, isi `https://domainwatch-xxxx.vercel.app/**`.
4. **Save**.

## Langkah 10 — Uji login dan tambah domain pertama

1. Buka alamat Vercel Anda. Anda akan diarahkan ke halaman **login**.
2. Masuk dengan email dan kata sandi dari Langkah 5.
3. Buka **Domain Saya**, isi domain milik Anda (misalnya `examplebrand.com`), biarkan ekstensi bawaan tercentang, klik **Tambah domain**.
4. Muat ulang halaman (F5). Domain tetap ada: artinya data tersimpan di database.

Jika muncul "Akses ditolak": email di Langkah 5.4 belum cocok. Jalankan ulang `setup-owner.sql` dengan email yang benar.

## Langkah 11 — Uji pengecekan nyata dan baseline

1. Klik nama domain Anda, lalu di salah satu varian (misalnya `.net`) klik **Cek sekarang**.
2. Status berubah menjadi **Terdaftar** atau **Belum terdaftar**.
3. Klik nama varian itu. Pastikan terisi: **Sumber data** (contoh `RDAP (rdap.verisign.com)`), **Baseline**, **Terakhir berhasil dicek**.
4. `.co` dan `.io` akan tampil **Tidak didukung** karena registrinya belum punya server RDAP resmi di daftar IANA. Itu normal.
5. Di Dashboard, **Cek semua sekarang** memeriksa semua varian di server (tunggu beberapa menit lalu muat ulang).

## Langkah 12 — Pastikan jadwal harian benar-benar berjalan

Jadwal: setiap hari pukul 01.00 UTC (sekitar **08.00–08.59 WIB**; paket Hobby bisa meleset hingga 59 menit).

1. Vercel > proyek Anda > **Settings** > **Cron Jobs**: harus ada `/api/cron/monitor` dengan jadwal `0 1 * * *`. Tombol **Run** di sana menjalankannya sekarang juga (untuk uji).
2. Vercel > **Logs**: cari `/api/cron/monitor`. Harus ada status **202**, lalu baris `DomainWatch monitor run`.
3. Di aplikasi: **Dashboard** menampilkan kotak hijau **"Pemantauan otomatis berjalan"** hanya jika proses terjadwal benar-benar pernah berjalan dalam 26 jam terakhir. **Pengaturan > Riwayat pemantauan** menampilkan setiap proses dengan jenis **Terjadwal**.

## Langkah 13 — Telegram (opsional)

1. Di Telegram, cari **@BotFather**, kirim `/newbot`, beri nama bot. BotFather mengirim **token**.
2. Vercel > **Settings** > **Environment Variables** > tambah `TELEGRAM_BOT_TOKEN` berisi token itu > **Save** > **Redeploy**.
3. Di Telegram, buka bot baru Anda dan tekan **Start**.
4. Di aplikasi: **Pengaturan** > **Cari Chat ID saya**. Salin angka yang muncul ke kolom **Chat ID**, centang **Aktifkan notifikasi Telegram**, klik **Simpan**.
5. Klik **Kirim pesan uji**. Pesan "✅ Pesan uji dari DomainWatch" harus masuk ke Telegram.

## Langkah 14 — Memperbarui aplikasi di masa depan

Setiap perubahan kode yang masuk ke branch `main` di GitHub otomatis di-deploy ulang oleh Vercel.

- Jika Claude membuat Pull Request baru: buka di GitHub, klik **Merge pull request**. Tunggu 1–3 menit, lalu cek **Deployments** di Vercel berstatus **Ready**.
- Jika ada file SQL baru di `supabase/migrations/`, jalankan file itu di Supabase SQL Editor seperti Langkah 4 (segera setelah merge). Claude akan menyebutkan file mana yang baru.
- Jika perlu kembali ke versi sebelumnya: Vercel > **Deployments** > pilih deployment lama > titik tiga > **Promote to Production**.

## Catatan batasan (paket gratis)

- Vercel Hobby: cron hanya sekali sehari, durasi fungsi maksimal 300 detik. Aplikasi membagi pekerjaan menjadi beberapa proses lanjutan otomatis bila domainnya banyak.
- Supabase Free: proyek yang tidak aktif selama 7 hari bisa di-*pause*. Pengecekan harian biasanya menjaga proyek tetap aktif, tetapi jika proyek ter-pause, buka dashboard Supabase dan klik **Restore**.
- "Belum terdaftar" tidak menjamin domain bisa dibeli (bisa premium, dicadangkan, atau dalam masa tunggu).
