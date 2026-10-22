# ⚡ LMS Auto-Pilot — AI Chrome Extension

Ekstensi Google Chrome (Manifest V3) otomatis berbasis AI untuk menyelesaikan modul pembelajaran (LMS) secara **Full Auto-Pilot**. Dirancang untuk menangani:

1. **Simulasi Tombol Interaktif & Jalankan Program**: Membaca instruksi tugas di layar, menekan urutan tombol konfigurasi/langkah yang benar satu per satu, lalu menekan tombol **Jalankan Program (Run / Execute)** dan memantau hingga output selesai.
2. **Soal Pilihan Ganda (Multiple Choice)**: Mendeteksi soal radio button, checkbox, maupun kartu opsi interaktif kustom, lalu memilih jawaban paling tepat berdasarkan analisis AI terhadap materi modul.
3. **Soal Esai & Isian Teks**: Mengisi `<textarea>`, `<input type="text">`, maupun editor kaya (`contenteditable`, Quill, CKEditor) menggunakan simulasi ketikan natural yang kompatibel dengan React, Vue, Angular, dan Moodle.
4. **Full Auto-Pilot Lintas Halaman**: Otomatis menekan tombol **Submit / Kirim Jawaban** dan berpindah ke **Modul Selanjutnya (Next)** hingga seluruh modul selesai.

---

## 📁 Struktur Proyek

- [manifest.json](manifest.json) — Konfigurasi Chrome Extension Manifest V3.
- [utils/storage.js](utils/storage.js) — Manajemen konfigurasi & state Auto-Pilot (`chrome.storage.local` + fallback `localStorage`).
- [background/ai-client.js](background/ai-client.js) — Klien Multi-AI (Google Gemini, OpenAI, Groq, Custom Endpoint) + **Smart Contextual Heuristic Engine**.
- [background/service-worker.js](background/service-worker.js) — Service Worker latar belakang untuk komunikasi API bebas kendala CORS.
- [content/scanner.js](content/scanner.js) — Pemindai heuristik DOM untuk simulasi tombol, tombol Run Program, pilihan ganda, esai, dan navigasi modul.
- [content/executor.js](content/executor.js) — Eksekutor event DOM realistis (`PointerEvent`, `MouseEvent`, native prototype value setter, `MutationObserver`).
- [content/hud.js](content/hud.js) — Panel kontrol melayang (*Floating HUD*) berbasis Shadow DOM di pojok layar LMS.
- [content/autopilot.js](content/autopilot.js) — Orkestrator siklus Full Auto-Pilot lintas modul.
- [popup/popup.html](popup/popup.html), [popup/popup.css](popup/popup.css), [popup/popup.js](popup/popup.js) — Antarmuka pengaturan ekstensi.
- [test/mock-lms.html](test/mock-lms.html) — Halaman simulasi LMS multi-modul untuk menguji seluruh fitur secara langsung.

---

## 🚀 Cara Instalasi di Google Chrome

1. Buka Google Chrome dan kunjungi alamat `chrome://extensions/`.
2. Aktifkan sakelar **Developer mode** (Mode pengembang) di pojok kanan atas.
3. Klik tombol **Load unpacked** (Muat yang belum dikemas).
4. Pilih folder repositori ini (`/workspaces/LMS-Automator`).
5. Ekstensi **LMS Auto-Pilot** siap digunakan!

---

## ⚙️ Cara Konfigurasi & Penggunaan

1. **Konfigurasi AI API Key (Opsional namun Direkomendasikan)**:
   - Klik ikon **LMS Auto-Pilot** di toolbar Chrome untuk membuka Popup pengaturan.
   - Pilih Provider AI: **Google Gemini** (`gemini-2.5-flash`), **OpenAI** (`gpt-4o-mini`), atau **Groq** (`llama-3.3-70b-versatile`).
   - Masukkan API Key Anda lalu klik **🔌 Test Koneksi AI** dan **💾 Simpan Pengaturan**.
   - *Catatan*: Jika Anda belum memasukkan API Key, ekstensi tetap dapat berjalan menggunakan **Smart Contextual Heuristic Engine** yang menganalisis instruksi langkah dan materi bacaan langsung dari halaman modul.
2. **Menjalankan Full Auto-Pilot di Halaman LMS**:
   - Buka halaman modul LMS Anda (atau buka file [test/mock-lms.html](test/mock-lms.html) di browser untuk simulasi).
   - Pada panel melayang **LMS Auto-Pilot AI** di pojok kanan bawah layar, klik tombol **▶ Start Auto-Pilot**.
   - Ekstensi akan memindai tugas, menekan urutan tombol yang benar, menjalankan program, memilih jawaban pilihan ganda, mengetik jawaban esai, mengirim jawaban, dan lanjut ke modul berikutnya secara otomatis.
   - Gunakan tombol **⚡ 1 Halaman** jika Anda hanya ingin menyelesaikan halaman aktif tanpa pindah halaman otomatis.