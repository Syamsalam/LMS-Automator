/**
 * LMS Auto-Pilot - Universal DOM Scanner & Task Detector
 * Mendeteksi:
 * 1. Tugas Simulasi Tombol Interaktif + Tombol Jalankan Program (Run/Execute)
 * 2. Soal Pilihan Ganda (Radio, Checkbox, Kartu Opsi Kustom)
 * 3. Soal Esai & Isian Teks (Textarea, Input Teks, ContentEditable Rich Editor)
 * 4. Tombol Submit Jawaban & Navigasi Modul Berikutnya (Next)
 */

let autoIdCounter = 1;

const LMSScanner = {
  runRegex: /\b(jalankan\s*program|jalankan\s*simulasi|jalankan\s*kode|jalankan|run\s*program|run\s*code|run\s*simulation|run\s*cell|run\s*script|eksekusi\s*program|eksekusi|execute|simulasikan|play\s*simulation|compile\s*&\s*run)\b/i,
  shortRunRegex: /^(?:[▶►▸▹▷⚡⚙️\u25B6\u25BA]\s*)?(?:run|jalankan|execute|eksekusi|play)(?:\s+(?:code|program|cell|script|simulasi|simulation|kode))?$/i,

  /**
   * Kumpulkan semua root DOM yang dapat diakses (dokumen utama, open Shadow DOM, dan same-origin iframe)
   */
  getAccessibleRoots(startRoot = document) {
    const roots = [startRoot];
    const seenRoots = new Set([startRoot]);

    const walk = (root) => {
      if (!root || typeof root.querySelectorAll !== 'function') return;
      let allEls = [];
      try {
        allEls = root.querySelectorAll('*');
      } catch {
        return;
      }
      for (const el of allEls) {
        if (el.id === 'lms-autopilot-hud-host') continue;
        if (el.shadowRoot && !seenRoots.has(el.shadowRoot)) {
          seenRoots.add(el.shadowRoot);
          roots.push(el.shadowRoot);
          walk(el.shadowRoot);
        }
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          try {
            const doc = el.contentDocument || el.contentWindow?.document;
            if (doc && doc.documentElement && !seenRoots.has(doc)) {
              seenRoots.add(doc);
              roots.push(doc);
              walk(doc);
            }
          } catch {
            // Cross-origin iframe ditangani oleh content script pada frame tersebut
          }
        }
      }
    };

    walk(startRoot);
    return roots;
  },

  queryAllDeep(selector, startRoot = document) {
    const results = [];
    const roots = this.getAccessibleRoots(startRoot);
    const seen = new Set();
    for (const r of roots) {
      if (!r || typeof r.querySelectorAll !== 'function') continue;
      try {
        const list = r.querySelectorAll(selector);
        for (const el of list) {
          if (!seen.has(el)) {
            seen.add(el);
            results.push(el);
          }
        }
      } catch {
        // Abaikan selector tidak valid
      }
    }
    return results;
  },

  /**
   * Berikan ID unik pada elemen DOM agar dapat diakses kembali oleh Executor
   */
  tagElement(el, prefix = 'el') {
    if (!el || typeof el.getAttribute !== 'function') return null;
    let existing = el.getAttribute('data-lms-auto-id');
    if (!existing) {
      existing = `lms-${prefix}-${autoIdCounter++}`;
      el.setAttribute('data-lms-auto-id', existing);
    }
    return existing;
  },

  /**
   * Berikan ID unik khusus untuk jangkar soal (`data-lms-question-id`) agar tidak bentrok dengan `data-lms-auto-id` milik opsi
   * maupun ketika 9 soal berada di dalam satu kontainer kartu Assessment yang sama.
   */
  tagQuestionElement(el, prefix = 'mcq') {
    if (!el || typeof el.getAttribute !== 'function') return null;
    let existing = el.getAttribute('data-lms-question-id');
    if (!existing) {
      existing = `lms-${prefix}-${autoIdCounter++}`;
      el.setAttribute('data-lms-question-id', existing);
    }
    return existing;
  },

  getElementById(autoId) {
    if (!autoId) return null;
    const esc = CSS.escape(autoId);
    const sel = `[data-lms-auto-id="${esc}"], [data-lms-question-id="${esc}"]`;
    const matches = this.queryAllDeep(sel, document);
    return matches[0] || null;
  },

  isVisible(el) {
    if (!el || el.nodeType !== 1 || typeof el.getBoundingClientRect !== 'function') return false;
    if (el.closest && el.closest('#lms-autopilot-hud-host')) return false;
    const win = el.ownerDocument?.defaultView || window;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    // Pastikan elemen tidak berada di luar layar secara horizontal (misal slide carousel sebelumnya/berikutnya)
    const vw = win.innerWidth || el.ownerDocument?.documentElement?.clientWidth || 1024;
    if (rect.right <= 2 || rect.left >= vw - 2) {
      return false;
    }

    // Cek apakah elemen terpotong secara horizontal oleh kontainer carousel (overflow-x: hidden/clip)
    let anc = el.parentElement;
    let depth = 0;
    while (anc && anc.nodeType === 1 && depth < 8) {
      if (anc.tagName === 'BODY' || anc.tagName === 'HTML') break;
      if (anc.clientWidth > 120) {
        const aRect = anc.getBoundingClientRect();
        if (rect.right <= aRect.left + 6 || rect.left >= aRect.right - 6) {
          const aStyle = win.getComputedStyle(anc);
          if (/^(hidden|clip|scroll|auto)$/i.test(aStyle.overflowX || aStyle.overflow || '')) {
            return false;
          }
        }
      }
      anc = anc.parentElement;
      depth++;
    }

    return true;
  },

  cleanText(str) {
    return (str || '').replace(/\s+/g, ' ').trim();
  },

  /**
   * Deteksi apakah suatu elemen berada di dalam panel Sidebar / Course Outline / Daftar Isi / Topbar
   * agar tidak pernah dianggap sebagai bagian dari materi modul, soal, maupun target scroll!
   */
  isInsideSidebarOrHeader(el) {
    if (!el || el.nodeType !== 1) return false;
    const sidebarHeaderSelector = [
      'aside',
      'nav',
      'header',
      '[role="navigation"]',
      '[role="banner"]',
      '[role="tree"]',
      '.sidebar',
      '.side-nav',
      '.sidenav',
      '.course-outline',
      '.outline-panel',
      '.curriculum-sidebar',
      '.toc',
      '.table-of-contents',
      '.drawer',
      '.navigation-drawer',
      '.left-panel',
      '.left-rail',
      '[class*="sidebar"]',
      '[class*="course-outline"]',
      '[class*="CourseOutline"]',
      '[class*="toc-"]',
      '[id*="sidebar"]',
      '[id*="course-outline"]'
    ].join(', ');

    if (el.closest && el.closest(sidebarHeaderSelector)) {
      return true;
    }

    // Heuristik Geometris untuk LMS seperti Cisco NetAcad:
    // Jika berada di kolom sempit di sisi kiri layar (lebar <= 380px, menempel di kiri)
    // pada layar desktop (lebar viewport >= 800px), atau berisi "Search course outline" / "Course Outline"
    const win = el.ownerDocument?.defaultView || window;
    const vw = win.innerWidth || 1024;
    if (vw >= 800) {
      let curr = el;
      let depth = 0;
      while (curr && curr.nodeType === 1 && depth < 8) {
        if (curr.tagName === 'BODY' || curr.tagName === 'HTML' || curr.tagName === 'MAIN') break;
        const rect = curr.getBoundingClientRect();
        if (rect.left <= 24 && rect.width >= 150 && rect.width <= 380 && rect.right <= vw * 0.42) {
          const txt = (curr.innerText || '').slice(0, 400);
          if (/\b(course\s*outline|search\s*course|resources|daftar\s*modul|daftar\s*isi)\b/i.test(txt)) {
            return true;
          }
          const style = win.getComputedStyle(curr);
          if (/^(auto|scroll|overlay)$/i.test(style.overflowY || '') && rect.height >= (win.innerHeight || 600) * 0.5) {
            return true;
          }
        }
        curr = curr.parentElement;
        depth++;
      }
    }

    return false;
  },

  /**
   * Deteksi apakah halaman saat ini adalah Halaman Daftar Modul / Modules Index
   * (Contoh: `https://awsacademy.instructure.com/courses/184279/modules` pada Canvas LMS, BUKAN `/modules/items/...`)
   */
  isModulesIndexPage() {
    const href = window.location.href || '';
    if (/\/modules\/items\//i.test(href)) {
      return false;
    }
    if (
      document.querySelector(
        '#context_modules, .context_module_items, li.context_module_item'
      )
    ) {
      return true;
    }
    return /\/courses\/[^/]+\/modules\/?(?:$|\?|#)/i.test(href);
  },

  /**
   * Deteksi apakah suatu elemen berada di dalam daftar modul / indeks modul (seperti `#context_modules` / `.context_module_item` di Canvas)
   * atau footer navigasi sekuensial Canvas (`.module-sequence-footer`), agar TIDAK PERNAH disalahartikan sebagai soal Pilihan Ganda (MCQ)!
   */
  isInsideModuleListIndex(el) {
    if (!el || el.nodeType !== 1) return false;
    return Boolean(
      el.closest &&
        el.closest(
          '#context_modules, .context_module, .context_module_items, .context_module_item, .ig-list, .ig-row, .module-sequence-footer, #module_sequence_footer'
        )
    );
  },

  /**
   * Simpan & baca daftar URL / ID item modul yang sudah dikunjungi selama sesi Auto-Pilot berlangsung
   * (agar saat kembali ke halaman `/modules`, Auto-Pilot otomatis membuka item modul berikutnya yang belum dikunjungi)
   */
  extractCanvasModuleItemId(url) {
    if (!url) return null;
    const s = String(url);
    const m1 = s.match(/\/modules\/items\/(\d+)/i);
    if (m1) return `item:${m1[1]}`;
    const m2 = s.match(/[?&]module_item_id=(\d+)/i);
    if (m2) return `item:${m2[1]}`;
    return null;
  },

  getVisitedModuleUrls() {
    try {
      const raw = sessionStorage.getItem('lms_autopilot_visited_modules');
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  },

  markModuleUrlVisited(url) {
    if (!url) return;
    try {
      const normalized = String(url).split('#')[0].trim();
      if (!normalized) return;
      const visited = this.getVisitedModuleUrls();
      visited.add(normalized);
      const itemIdKey = this.extractCanvasModuleItemId(url);
      if (itemIdKey) visited.add(itemIdKey);
      sessionStorage.setItem('lms_autopilot_visited_modules', JSON.stringify(Array.from(visited).slice(-300)));
    } catch {}
  },

  isModuleUrlVisited(url) {
    if (!url) return false;
    const visited = this.getVisitedModuleUrls();
    const normalized = String(url).split('#')[0].trim();
    if (visited.has(normalized)) return true;
    const itemIdKey = this.extractCanvasModuleItemId(url);
    return Boolean(itemIdKey && visited.has(itemIdKey));
  },

  /**
   * Pindai seluruh halaman aktif dan kembalikan struktur data lengkap
   */
  scanPage(config = {}) {
    const customSelectors = config.customSelectors || {};
    const pageTitle = this.cleanText(document.title);
    const isModIndex = this.isModulesIndexPage();

    // Jika berada di dalam halaman item modul (bukan halaman daftar `/modules`), catat URL-nya sebagai sudah dikunjungi
    if (!isModIndex && window === window.top) {
      this.markModuleUrlVisited(window.location.href);
    }

    const moduleContext = isModIndex ? '' : this.extractModuleContext();

    // Pada halaman daftar modul (`/courses/.../modules`), jangan memindai daftar modul sebagai soal PG/Simulasi/Esai!
    const simulations = isModIndex ? [] : this.scanSimulations(customSelectors);
    const mcqs = isModIndex ? [] : this.scanMCQs(customSelectors, simulations);
    const inlineBlanks = isModIndex ? [] : this.scanInlineBlanks(customSelectors, simulations);
    const actionPrompts = isModIndex ? [] : this.scanActionPrompts(customSelectors, simulations);
    const videos = isModIndex ? [] : this.scanVideos();
    const essays = isModIndex ? [] : this.scanEssays(customSelectors, simulations);
    const navigation = this.scanNavigation(customSelectors, simulations);

    return {
      url: window.location.href,
      pageTitle,
      isModulesIndexPage: isModIndex,
      moduleContext,
      simulations,
      mcqs,
      inlineBlanks,
      actionPrompts,
      videos,
      essays,
      navigation,
      summary: {
        simulationCount: simulations.length + actionPrompts.length + videos.length,
        mcqCount: mcqs.length + inlineBlanks.length,
        essayCount: essays.length,
        hasSubmit: Boolean(navigation.submitButtonId),
        hasNext: Boolean(navigation.nextButtonId)
      }
    };
  },

  /**
   * Ekstrak teks materi pembelajaran pada halaman modul untuk konteks AI
   */
  extractModuleContext() {
    const mainSelectors = [
      'main',
      'article',
      '[role="main"]',
      '.module-content',
      '.lesson-content',
      '.course-content',
      '.learning-content',
      '#region-main',
      '.content-wrapper'
    ];

    let root = null;
    for (const sel of mainSelectors) {
      const candidate = document.querySelector(sel);
      if (candidate && this.isVisible(candidate)) {
        root = candidate;
        break;
      }
    }
    if (!root) root = document.body;

    const clone = root.cloneNode(true);
    const ignored = clone.querySelectorAll(
      'script, style, noscript, nav, footer, header, #lms-autopilot-hud-host, svg, button, .options-list, .sim-buttons-grid, .nav-footer'
    );
    ignored.forEach((n) => n.remove());

    const rawText = clone.innerText || clone.textContent || '';
    return rawText
      .split(/\n+/)
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .filter((line) => line.length > 0)
      .join('\n')
      .slice(0, 6000);
  },

  /**
   * Cek apakah teks tombol merupakan tombol Submit / Check / Navigasi / Chapter Assessment
   * (bukan blok kode atau langkah simulasi)
   */
  isSubmitOrNavButtonText(label) {
    const txt = this.cleanText(label);
    if (!txt) return false;
    if (
      /^(?:submit|kirim|send|save|simpan|check|periksa|verify|verifikasi|done|selesai|next|continue|lanjut|lanjutkan|previous|sebelumnya|assessment|quiz)$/i.test(
        txt
      )
    ) {
      return true;
    }
    // Tombol yang diakhiri tanda panah/chevron navigasi seperti "Chapter Assessment >", "Explore painting ›", atau tombol panah tunggal ">"
    if (/^[>›»→➔⟶\u203A\u276F<‹«←]+$/.test(txt)) {
      return true;
    }
    if (
      /[>›»→➔⟶\u203A\u276F]\s*$/.test(txt) &&
      !/[=()]|\b(import|from|def|print|read_csv)\b/.test(txt)
    ) {
      return true;
    }
    return /\b(selanjutnya|berikutnya|next\s*module|next\s*lesson|next\s*step|next\s*section|next\s*chapter|next\s*page|modul\s*selanjutnya|chapter\s*assessment|module\s*assessment|unit\s*assessment|final\s*assessment|practice\s*assessment|start\s*assessment|take\s*assessment|chapter\s*quiz|module\s*quiz|start\s*quiz|kirim\s*semua|kirim\s*jawaban|kirim\s*tugas|submit\s*quiz|submit\s*answer|submit\s*response|check\s*answer|periksa\s*jawaban|simpan\s*&\s*kirim|verifikasi\s*jawaban|selesai\s*kuis|finish\s*attempt|previous|sebelumnya)\b/i.test(
      txt
    );
  },

  /**
   * Cek apakah suatu elemen adalah tautan berkas / referensi eksternal (seperti PDF "Chatbot tips", "Notebook tips")
   */
  isResourceOrExternalLink(el) {
    if (!el || el.nodeType !== 1) return false;
    const anchor = el.tagName === 'A' ? el : el.closest ? el.closest('a') : null;
    if (!anchor) return false;
    const href = (anchor.getAttribute('href') || '').trim();
    if (anchor.hasAttribute('download') || anchor.getAttribute('target') === '_blank') {
      return true;
    }
    if (/\.(pdf|ipynb|zip|docx?|xlsx?|pptx?|csv|txt)(\?|$|#)/i.test(href)) {
      return true;
    }
    if (/^https?:\/\//i.test(href) && !href.includes(window.location.hostname)) {
      return true;
    }
    const txt = this.cleanText(anchor.innerText || '');
    if (/\b(chatbot\s*tips|notebook\s*tips|download\s*pdf|resources\s*for\s*getting\s*help)\b/i.test(txt)) {
      return true;
    }
    return false;
  },

  /**
   * Cek apakah suatu elemen adalah tombol pemicu langkah / pembuka konten interaktif
   * Contoh pada NetAcad: "Click here to represent the painting as data...", "Show both dataframes...", "Continue..."
   */
  isActionPromptElement(el, customSelectors = {}) {
    if (!el || el.nodeType !== 1 || !this.isVisible(el) || el.disabled) return false;
    if (this.isInsideSidebarOrHeader(el) || this.isInsideModuleListIndex(el)) return false;
    if (this.isResourceOrExternalLink(el)) return false;
    if (this.isPopoverContainer(el) || el.closest('[data-popover], .popover, .slot-popover, .blank-popover')) return false;
    if (this.isInlineBlankTrigger(el)) return false;
    if (this.isRunButtonElement(el, customSelectors)) return false;
    if (el.closest('.py-editor-box, .code-editor, .editor-box, .code-box, .code-cell-editor')) return false;

    const txt = this.cleanText(el.innerText || el.value || el.getAttribute('aria-label') || '');
    if (!txt || txt.length < 4 || txt.length > 130) return false;

    // PENTING: Jangan pernah mengklik tombol ulang kuis ("Take the Survey Again", "Take the Quiz Again", "Retake")
    // atau tombol administrasi halaman ("+ Add Discussion", "Collapse All", "Expand All", "Settings", "View Progress")!
    if (
      /\b(again|retake|ulangi|add\s+discussion|new\s+discussion|collapse\s+all|expand\s+all|settings|view\s+progress)\b/i.test(
        txt
      )
    ) {
      return false;
    }

    // Deteksi langsung tombol eksplisit pembuka kuis Canvas / Articulate Rise / Mark as Done (selama bukan tombol "... Again")
    if (
      el.id === 'take_quiz_link' ||
      (el.id === 'mark-as-done-checkbox' && !el.classList.contains('checked')) ||
      (el.matches &&
        el.matches(
          '.take_quiz_button a, button[data-automation*="take-quiz" i], .cover__header-content-action-link, a.overview__button, button.overview__button, button.continue-btn'
        ))
    ) {
      return true;
    }

    // Jangan anggap tombol navigasi bab/assessment ("Chapter Assessment >") sebagai action prompt lokal
    if (/\b(chapter\s*assessment|module\s*assessment|unit\s*assessment|final\s*assessment)\b/i.test(txt)) {
      return false;
    }
    if (/[>›»→➔⟶\u203A\u276F]\s*$/.test(txt)) {
      return false;
    }

    // Jangan anggap blok kode Python (`import ...`, `internet = ...`, `#display ...`) sebagai action prompt
    if (/[=()]|\b(import\s+\w+|from\s+\w+\s+import|read_csv|DataFrame|matplotlib|pyplot)\b|^#/.test(txt)) {
      return false;
    }

    const cls = `${el.className || ''} ${el.getAttribute('data-action') || ''}`;
    if (/\b(next-step|step-btn|reveal-btn|continue-btn)\b/i.test(cls) || el.hasAttribute('data-next-step')) {
      return true;
    }

    const actionPromptRegex =
      /\b(click\s+here\b|klik\s+di\s*sini\b|tap\s+here\b|click\s+to\s+(?:reveal|explore|represent|view|start|begin|see|open|load|show)|show\s+(?:both|the|all|data|dataframe|dataframes|table|tables|plot|plots|graph|chart|result|results|code|more|answer|solution|step|image|images|painting|paintings)|reveal\s+(?:data|table|answer|more|all|the)|represent\s+the\s+\w+\s+as\s+data|tampilkan\s+(?:data|tabel|kedua|semua)|mulai\s+(?:simulasi|kuis|evaluasi|modul|kursus|belajar|lab)|start\s+(?:quiz|the\s+quiz|survey|the\s+survey|attempt|course|module|lesson|learning|knowledge\s*check|assessment|lab|activity)|begin\s+(?:quiz|the\s+quiz|survey|attempt|course|module|lesson|learning|knowledge\s*check|assessment)|resume\s+(?:course|module|lesson|learning|quiz|the\s+quiz|survey)|launch\s+(?:course|module|lesson|content|knowledge\s*check|lab)|open\s+(?:module|lesson|course|quiz|knowledge\s*check)|take\s+(?:quiz|the\s+quiz|survey|the\s+survey|knowledge\s*check)|enter\s+(?:course|module|lesson)|mark\s+as\s+(?:complete|done)|complete\s+and\s+continue|lanjutkan\s+belajar)\b/i;

    // Di NetAcad / Mathigon, tombol pembuka langkah hampir selalu diakhiri elipsis "..." atau "…"
    // (contoh: "Show both dataframes...", "Click here to represent the painting as data...")
    const endsWithEllipsis = /(?:\.{3}|…)\s*$/.test(txt) && !/^\[\s*(?:\.{2,}|…)\s*\]$/.test(txt);

    // Di AWS Skill Builder / Articulate Rise / Canvas / Coursera, tombol masuk ke dalam modul di area utama
    // sering bertuliskan "Start", "Resume", "Launch", "Start Course", "Start Module", "Start Quiz", "Take the Survey", "Begin", atau "Continue"
    const isEntryButtonText =
      /^(?:start|resume|launch|begin|mulai|buka\s+modul|mulai\s+modul|start\s+course|resume\s+course|start\s+module|resume\s+module|launch\s+module|launch\s+course|start\s+lesson|start\s+quiz|take\s+the\s+quiz|take\s+the\s+survey|resume\s+quiz|start\s+knowledge\s+check|take\s+quiz|begin\s+course|continue\s+course|continue\s+learning)$/i.test(
        txt
      );

    if (!actionPromptRegex.test(txt) && !endsWithEllipsis && !isEntryButtonText) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width < 48 || rect.height < 20 || rect.height > 110) return false;

    const win = el.ownerDocument?.defaultView || window;
    const style = win.getComputedStyle(el);
    return (
      el.tagName === 'BUTTON' ||
      el.tagName === 'A' ||
      el.getAttribute('role') === 'button' ||
      style.cursor === 'pointer' ||
      this.hasVisualPillStyle(el)
    );
  },

  /**
   * Cek apakah suatu elemen merupakan tombol Run / Jalankan Program (termasuk tombol pendek seperti "▶ run")
   */
  isRunButtonElement(el, customSelectors = {}) {
    if (!el || !this.isVisible(el)) return false;

    if (customSelectors.runProgramButton) {
      try {
        if (el.matches(customSelectors.runProgramButton)) return true;
      } catch {}
    }

    if (
      el.hasAttribute('data-run-program') ||
      el.getAttribute('data-action') === 'run' ||
      el.classList.contains('run-program-btn')
    ) {
      return true;
    }

    const text = this.cleanText(
      el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || ''
    );
    if (!text || text.length > 45) return false;

    const tag = el.tagName.toUpperCase();
    const isStandardBtn =
      tag === 'BUTTON' ||
      tag === 'INPUT' ||
      el.getAttribute('role') === 'button';

    if (isStandardBtn && (this.runRegex.test(text) || this.shortRunRegex.test(text))) {
      return true;
    }

    // Untuk elemen kustom (div, span, a) yang berfungsi sebagai tombol "▶ run" / "run"
    if (tag === 'DIV' || tag === 'SPAN' || tag === 'A') {
      if (this.shortRunRegex.test(text) || this.runRegex.test(text)) {
        const win = el.ownerDocument?.defaultView || window;
        const style = win.getComputedStyle(el);
        const cls = `${el.className || ''} ${el.id || ''}`;
        const looksClickable =
          style.cursor === 'pointer' ||
          parseFloat(style.borderRadius) >= 3 ||
          /\b(run|btn|button|play|exec)\b/i.test(cls);
        if (looksClickable) {
          return true;
        }
      }
    }

    return false;
  },

  /**
   * Deteksi apakah elemen adalah balon / kontainer popover pilihan (seperti balon [2] [34] [35] atau pilihan slot kode)
   */
  isPopoverContainer(el) {
    if (!el || el.nodeType !== 1) return false;
    const cls = `${el.className || ''} ${el.id || ''} ${el.getAttribute('role') || ''} ${el.getAttribute('data-radix-popper-content-wrapper') || ''}`;
    if (
      /\b(popover|tooltip|dropdown-menu|options-popup|choice-popover|slot-popover|blank-popover|balloon|popper|tippy|listbox|menu)\b/i.test(cls) ||
      el.hasAttribute('data-popover') ||
      el.hasAttribute('data-slot-options')
    ) {
      return true;
    }
    return false;
  },

  /**
   * Deteksi apakah elemen adalah tombol/kotak rumpang inline `[...]` pada kalimat (seperti `There are [...] rows of data...`)
   */
  isInlineBlankTrigger(el) {
    if (!el || el.nodeType !== 1 || !this.isVisible(el)) return false;
    if (this.isPopoverContainer(el) || el.closest('[data-popover], .popover, .slot-popover, .blank-popover')) {
      return false;
    }
    const cls = `${el.className || ''} ${el.getAttribute('data-type') || ''}`;
    if (
      el.hasAttribute('data-inline-blank') ||
      el.hasAttribute('data-cloze') ||
      /\b(inline-blank|cloze-blank|fill-blank|sentence-blank|output-blank)\b/i.test(cls)
    ) {
      return true;
    }

    // Jangan anggap slot `[▪]` di dalam tile blok kode (`internet = [▪].read_csv([▪])`) sebagai inline blank kalimat
    if (el.closest('.py-tile, .code-tile, .code-block, [data-tile], [data-code], .py-editor-box, .code-editor')) {
      return false;
    }

    const txt = this.cleanText(el.innerText || el.value || '');
    // Teks persis seperti `[...]`, `[…]`, `...`, `…`, `[ ]`, `[?]`
    const blankPattern = /^\[\s*(?:\.{2,}|…|_|\?|\s)\s*\]$|^(?:\.{3,}|…|\[\s*\])$/;
    if (blankPattern.test(txt)) {
      // Jika elemen induk memiliki teks yang persis sama (misal <button><span>[...]</span></button>), pilih elemen induknya saja
      const parentTxt = el.parentElement ? this.cleanText(el.parentElement.innerText || '') : '';
      if (parentTxt === txt) {
        return false;
      }
      // Jika elemen induk adalah pill kode pendek yang mengandung sintaks kode (`=`, `.read_csv(`, `#display`), maka ini adalah slot blok kode, bukan kalimat
      if (
        el.parentElement &&
        this.hasVisualPillStyle(el.parentElement) &&
        /[=()#.]|\b(import|from|def|return|print|read_csv)\b/.test(parentTxt)
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width >= 12 && rect.width <= 180 && rect.height >= 12 && rect.height <= 65) {
        return true;
      }
    }
    return false;
  },

  /**
   * Deteksi apakah elemen adalah kotak placeholder / slot isian abu-abu di dalam blok kode
   * Contoh: `internet = [▪].read_csv( [▪] )` atau `[▪] #display the dataframe`
   */
  isPlaceholderSlotElement(el, parentTileEl) {
    if (!el || el.nodeType !== 1 || el === parentTileEl) return false;
    if (this.isPopoverContainer(el)) return false;
    if (parentTileEl && el.parentElement && el.parentElement !== parentTileEl && this.isPopoverContainer(el.parentElement)) {
      return false;
    }

    const tag = el.tagName.toUpperCase();
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;

    const cls = `${el.className || ''} ${el.getAttribute('data-type') || ''} ${el.getAttribute('data-slot') || ''} ${el.getAttribute('role') || ''}`;
    if (
      el.hasAttribute('data-slot') ||
      /\b(slot|blank|placeholder|hole|gap|empty|fill|drop-target|token-slot|code-slot|input-slot|py-slot-box)\b/i.test(cls)
    ) {
      return true;
    }

    const txt = this.cleanText(el.innerText || el.textContent || '');
    if (
      !txt ||
      /^[_▪▫•?…\-\s\u00A0]+$/.test(txt) ||
      /^\[\s*(?:\.{2,}|…|_|\?|\s)\s*\]$/.test(txt)
    ) {
      const rect = el.getBoundingClientRect();
      if (rect.width >= 8 && rect.height >= 10 && rect.width <= 180 && rect.height <= 60) {
        const win = el.ownerDocument?.defaultView || window;
        const style = win.getComputedStyle(el);
        const hasBg =
          style.backgroundColor &&
          style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
          style.backgroundColor !== 'transparent';
        const hasBorder =
          parseFloat(style.borderTopWidth) > 0 ||
          parseFloat(style.borderBottomWidth) > 0 ||
          parseFloat(style.borderLeftWidth) > 0;
        if (hasBg || hasBorder) {
          return true;
        }
      }
    }
    return false;
  },

  /**
   * Cek apakah sebuah elemen slot masih kosong / belum dipilih nilainya
   */
  isSlotUnfilled(slotEl) {
    if (!slotEl || slotEl.nodeType !== 1) return false;
    // Jika elemen slot/blank sudah diganti di DOM atau disembunyikan oleh LMS setelah diisi, maka sudah terisi!
    if (!slotEl.isConnected || !this.isVisible(slotEl)) {
      return false;
    }
    if (slotEl.getAttribute('data-filled') === 'true' || slotEl.classList.contains('filled')) {
      return false;
    }
    if (slotEl.tagName === 'SELECT') {
      return !slotEl.value || slotEl.selectedIndex <= 0;
    }
    const rawVal = this.cleanText(slotEl.value || slotEl.innerText || slotEl.textContent || '');
    if (!rawVal) return true;
    if (/^[_▪▫•?…\-\s\u00A0]+$/.test(rawVal)) return true;
    if (/^\[\s*(?:\.{2,}|…|_|\?|\s)\s*\]$|^(?:\.{3,}|…|\[\s*\])$/.test(rawVal)) return true;
    return false;
  },

  /**
   * Cari semua elemen slot yang masih belum terisi di dalam suatu blok kode atau kotak editor
   */
  findUnfilledSlotsInScope(scopeEl) {
    if (!scopeEl) return [];
    const allDescendants = this.queryAllDeep('*', scopeEl);
    const unfilled = [];
    for (const el of allDescendants) {
      if (!this.isVisible(el)) continue;
      if (this.isPopoverContainer(el) || el.closest('[data-popover], .popover, .slot-popover, .blank-popover')) continue;
      if (this.isPlaceholderSlotElement(el, scopeEl) && this.isSlotUnfilled(el)) {
        // Pastikan tidak mengambil parent jika child-nya juga slot
        if (!unfilled.some((prev) => prev.contains(el) || el.contains(prev))) {
          unfilled.push(el);
        }
      }
    }
    return unfilled;
  },

  /**
   * Cari tombol-tombol pilihan di dalam balon popover yang muncul untuk suatu slot (`[▪]` atau `[...]`)
   */
  findPopoverOptionsForTarget(
    targetEl,
    beforeVisibleSet = null,
    excludeIds = new Set(),
    editorBoxEl = null,
    requireNewlyVisible = false
  ) {
    const candidates = [];
    const seenEls = new Set();

    // Kumpulkan elemen DOM dari excludeIds agar kita juga bisa mengecek relasi contains()
    const excludedEls = [];
    for (const id of excludeIds) {
      const exEl = this.getElementById(id);
      if (exEl) excludedEls.push(exEl);
    }

    const isExcludedOrTile = (el) => {
      if (!el) return true;
      const autoId = el.getAttribute('data-lms-auto-id');
      if (autoId && excludeIds.has(autoId)) return true;
      return excludedEls.some((ex) => ex === el || ex.contains(el) || el.contains(ex));
    };

    const addOptionCandidate = (el, fromExplicitPopover = false) => {
      if (!el || el.nodeType !== 1 || seenEls.has(el)) return;
      if (!this.isVisible(el) || el.disabled) return;
      if (el === targetEl || (targetEl && (el.contains(targetEl) || targetEl.contains(el)))) return;
      if (!fromExplicitPopover && editorBoxEl && (el === editorBoxEl || editorBoxEl.contains(el))) return;
      if (this.isPlaceholderSlotElement(el, null)) return;
      if (isExcludedOrTile(el)) return;
      if (this.isRunButtonElement(el)) return;
      if (this.isInlineBlankTrigger(el)) return;

      const txt = this.cleanText(el.innerText || el.value || '');
      if (!txt || txt.length > 90) return;
      if (/^[≡☰⋮×✕▶►]+$/.test(txt)) return;
      if (/\b(kirim\s*jawaban|modul\s*selanjutnya|next\s*module|submit\s*quiz|start\s*auto-pilot|reset\s*pipeline|reset\s*konfigurasi)\b/i.test(txt)) return;

      seenEls.add(el);
      candidates.push(el);
    };

    // 1. Cari di dalam kontainer popover eksplisit yang sedang terlihat di halaman (yang berada di dekat targetEl atau baru muncul)
    const popoverBoxes = this.queryAllDeep(
      '[data-popover], [data-slot-options], .popover, .slot-popover, .blank-popover, .choice-popover, .options-popup, .dropdown-menu, .balloon, [role="listbox"], [role="menu"], [role="tooltip"], .tippy-box, [class*="popover"], [class*="balloon"], [class*="callout"]'
    ).filter((box) => {
      if (!this.isVisible(box)) return false;
      if (editorBoxEl && (box === editorBoxEl || box.contains(editorBoxEl))) return false;
      if (beforeVisibleSet && !beforeVisibleSet.has(box)) return true;
      if (targetEl && this.isVisible(targetEl)) {
        if (targetEl.contains(box) || box.contains(targetEl) || targetEl.parentElement?.contains(box)) return true;
        const tRect = targetEl.getBoundingClientRect();
        const bRect = box.getBoundingClientRect();
        const vDist = Math.min(Math.abs(bRect.top - tRect.bottom), Math.abs(tRect.top - bRect.bottom));
        return vDist <= 160;
      }
      return true;
    });

    for (const box of popoverBoxes) {
      const items = this.queryAllDeep('button, [role="button"], [role="option"], [data-option], li, span, div, a, code', box);
      const leafItems = items.filter(
        (item) =>
          item !== box &&
          this.isVisible(item) &&
          !items.some((other) => other !== item && item.contains(other) && this.cleanText(other.innerText || '') !== '')
      );
      leafItems.forEach((item) => addOptionCandidate(item, true));
    }

    // 2. Jika ada beforeVisibleSet (elemen yang terlihat sebelum slot diklik), ambil elemen klik yang BARU muncul di luar editorBoxEl
    if (candidates.length === 0 && beforeVisibleSet) {
      const allClickables = this.queryAllDeep('button, [role="button"], [role="option"], [data-option], li, span, div, a, code');
      const newlyVisible = allClickables.filter((el) => {
        if (!this.isVisible(el) || beforeVisibleSet.has(el)) return false;
        if (editorBoxEl && (el === editorBoxEl || editorBoxEl.contains(el))) return false;
        if (isExcludedOrTile(el)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 14 && rect.width <= 320 && rect.height >= 14 && rect.height <= 65;
      });
      const leafNewly = newlyVisible.filter(
        (el) => !newlyVisible.some((other) => other !== el && el.contains(other))
      );
      leafNewly.forEach((item) => addOptionCandidate(item, false));
    }

    // 3. Kedekatan Geometris (Visual Proximity): hanya digunakan jika balon sudah terbuka di bawah targetEl (misal di bawah `[...]`)
    if (!requireNewlyVisible && candidates.length === 0 && targetEl && this.isVisible(targetEl)) {
      const tRect = targetEl.getBoundingClientRect();
      const allBoxes = this.queryAllDeep('div, ul, section, span');
      for (const box of allBoxes) {
        if (!this.isVisible(box) || box === targetEl || box.contains(targetEl) || targetEl.contains(box)) continue;
        if (editorBoxEl && (box === editorBoxEl || box.contains(editorBoxEl) || editorBoxEl.contains(box))) continue;
        if (box.id === 'py-tiles-pool' || box.classList.contains('py-tiles-pool') || box.classList.contains('sim-buttons-grid')) {
          continue;
        }
        // Jangan pernah mengambil kontainer yang membungkus blok kode utama (excludedEls)
        if (excludedEls.some((ex) => box === ex || box.contains(ex))) continue;

        const bRect = box.getBoundingClientRect();
        if (bRect.width < 36 || bRect.width > 520 || bRect.height < 20 || bRect.height > 160) continue;

        // Balon pilihan selalu berada tepat di bawah (atau menempel pada) targetEl, BUKAN di atasnya
        const gapBelow = bRect.top - tRect.bottom;
        const horizontalOverlap =
          bRect.right >= tRect.left - 120 && bRect.left <= tRect.right + 120;

        if (gapBelow >= -12 && gapBelow <= 85 && horizontalOverlap) {
          const children = Array.from(box.querySelectorAll('button, [role="button"], [role="option"], span, div, li, a, code')).filter(
            (c) =>
              c !== box &&
              this.isVisible(c) &&
              !isExcludedOrTile(c) &&
              this.hasVisualPillStyle(c)
          );
          const leafChildren = children.filter(
            (c) => !children.some((other) => other !== c && c.contains(other))
          );
          if (leafChildren.length >= 2 && leafChildren.length <= 10) {
            leafChildren.forEach((item) => addOptionCandidate(item, false));
            if (candidates.length > 0) break;
          }
        }
      }
    }

    return candidates.map((el) => ({
      id: this.tagElement(el, 'pop-opt'),
      text: this.cleanText(el.innerText || el.value || ''),
      el
    }));
  },

  /**
   * Ekstrak teks label dari tombol / blok kode beserta posisi slot kosong (`___`)
   */
  extractTileInfo(tileEl) {
    const slots = [];
    const parts = [];

    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        parts.push(node.nodeValue || '');
        return;
      }
      if (node.nodeType !== 1) return;
      // Jangan masukkan teks dari balon popover yang tersembunyi/terbuka di dalam blok kode
      if (this.isPopoverContainer(node)) return;

      if (this.isPlaceholderSlotElement(node, tileEl)) {
        const slotId = this.tagElement(node, 'slot');
        const currentVal = this.cleanText(node.value || node.innerText || '');
        const cleanVal =
          /^[_▪▫•?…\-\s\u00A0]+$/.test(currentVal) ||
          /^\[\s*(?:\.{2,}|…|_|\?|\s)\s*\]$/.test(currentVal)
            ? ''
            : currentVal;

        // Cek apakah slot memiliki atribut data-options (daftar pilihan untuk slot ini)
        const rawOpts = node.getAttribute('data-options') || '';
        const slotOptions = rawOpts
          ? rawOpts.split('|').map((s) => s.trim()).filter(Boolean)
          : [];

        slots.push({
          id: slotId,
          isInput:
            node.tagName === 'INPUT' ||
            node.tagName === 'TEXTAREA' ||
            Boolean(node.isContentEditable),
          currentValue: cleanVal,
          options: slotOptions
        });
        parts.push(cleanVal ? ` ${cleanVal} ` : ' ___ ');
        return;
      }
      for (const child of node.childNodes) {
        walk(child);
      }
    };

    walk(tileEl);
    const labelWithSlots = this.cleanText(parts.join(''));
    const rawLabel = this.cleanText(
      tileEl.innerText || tileEl.value || tileEl.getAttribute('aria-label') || tileEl.getAttribute('title') || ''
    );
    return {
      label: labelWithSlots || rawLabel,
      rawLabel,
      slotCount: slots.length,
      slots
    };
  },

  /**
   * Cek apakah suatu elemen merupakan kotak visual bergaya tombol/pill
   */
  hasVisualPillStyle(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName.toUpperCase();
    if (tag === 'BUTTON' || el.getAttribute('role') === 'button') return true;
    const win = el.ownerDocument?.defaultView || window;
    const style = win.getComputedStyle(el);
    const hasBg =
      style.backgroundColor &&
      style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
      style.backgroundColor !== 'transparent';
    const hasRadius =
      parseFloat(style.borderRadius) >= 3 ||
      parseFloat(style.borderTopLeftRadius) >= 3;
    const hasBorder =
      parseFloat(style.borderTopWidth) > 0 ||
      parseFloat(style.borderBottomWidth) > 0 ||
      (style.boxShadow && style.boxShadow !== 'none');
    return Boolean(hasBg && (hasRadius || hasBorder));
  },

  /**
   * Cek apakah elemen adalah pembungkus (wrapper) yang berisi beberapa tombol/tile sekaligus
   */
  isTileWrapper(el) {
    if (!el || el.nodeType !== 1) return false;
    const children = Array.from(el.querySelectorAll('button, [role="button"], div, span, li, code, a'));
    const pillChildren = [];
    for (const child of children) {
      if (child === el || !this.isVisible(child)) continue;
      if (this.isPlaceholderSlotElement(child, el)) continue;
      const txt = this.cleanText(child.innerText || child.value || '');
      if (!txt) continue;
      const rect = child.getBoundingClientRect();
      if (rect.width >= 24 && rect.height >= 18 && rect.height <= 115 && this.hasVisualPillStyle(child)) {
        if (!pillChildren.some((p) => p.contains(child) || child.contains(p))) {
          pillChildren.push(child);
        }
      }
      if (pillChildren.length >= 2) return true;
    }
    return false;
  },

  /**
   * Cari kotak editor kode gelap (seperti `[1] python` dengan nomor baris `1 2 3 4 5` & tombol `▶ run`)
   * Pastikan mengembalikan kontainer editor terluar (yang mencakup header `python`, nomor baris, dan baris kode),
   * bukan sekadar wrapper kecil di sekitar tombol `▶ run`.
   */
  findCodeEditorBox(container, runBtns = []) {
    if (!container || container.nodeType !== 1) return null;
    const editorSelector =
      '.py-editor-box, .code-editor, .editor-box, .code-box, .code-cell-editor, .monaco-editor, .CodeMirror, .cm-editor, [data-code-editor]';

    // Jika container itu sendiri adalah elemen editor (atau berada di dalam elemen editor)
    if (container.matches && container.matches(editorSelector)) {
      return container;
    }
    const ancestorEditor = container.closest ? container.closest(editorSelector) : null;
    if (ancestorEditor) {
      return ancestorEditor;
    }

    // 1. Cari eksplisit elemen editor di dalam container terlebih dahulu
    const explicitEditor = container.querySelector(editorSelector);
    if (explicitEditor) {
      return explicitEditor;
    }

    // 2. Jika ada tombol Run di dalam kotak editor gelap / kotak bernomor baris, telusuri ke atas hingga batas editorBox terluar
    for (const rBtn of runBtns) {
      let curr = rBtn.parentElement;
      let outerMatch = null;

      while (curr && container.contains(curr)) {
        const win = curr.ownerDocument?.defaultView || window;
        const style = win.getComputedStyle(curr);
        const bgStr = style.backgroundColor || '';
        const isTransparent = bgStr === 'transparent' || /rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(?:\.0+)?\s*\)/.test(bgStr);
        const bgMatch = !isTransparent ? bgStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/) : null;
        const isDarkBox =
          Boolean(bgMatch) &&
          Number(bgMatch[1]) < 75 &&
          Number(bgMatch[2]) < 75 &&
          Number(bgMatch[3]) < 95;
        const txt = this.cleanText(curr.innerText || '');
        const hasLineNumbersOrLang =
          /\b(python|javascript|sql|java|c\+\+|html|css|bash|ruby|php)\b/i.test(txt) ||
          /\b1\s+2\s+3\b/.test(txt);

        // Cek apakah curr sudah terlalu tinggi hingga ikut mencakup area kumpulan blok kode biru di bawah editor
        const rect = curr.getBoundingClientRect();
        const rRect = rBtn.getBoundingClientRect();
        const extendsFarBelowRunBtn = rect.bottom - rRect.bottom > 55;

        if (extendsFarBelowRunBtn) {
          break;
        }

        if (
          (isDarkBox && hasLineNumbersOrLang) ||
          /\b(py-editor-box|code-editor|editor-box|code-box|code-cell|notebook-cell)\b/i.test(curr.className || '')
        ) {
          outerMatch = curr;
        }
        if (curr === container) break;
        curr = curr.parentElement;
      }

      if (outerMatch) {
        return outerMatch;
      }
    }

    return null;
  },

  /**
   * Kumpulkan semua tombol langkah / blok kode (code tiles) kandidat di dalam kontainer simulasi
   */
  collectCandidateTiles(container, runBtns = [], customSelectors = {}) {
    if (!container) return [];

    const editorBox = this.findCodeEditorBox(container, runBtns);
    const explicitSelector =
      'button, [role="button"], .sim-btn, .step-btn, [data-sim-step], .code-tile, .code-block, .tile, .block, .token, .piece, .choice, .option, .chip, .snippet, [draggable="true"], [data-tile], [data-block], [data-code]';

    const rawPool = new Set(this.queryAllDeep(explicitSelector, container));

    if (customSelectors.simulationButtons) {
      try {
        this.queryAllDeep(customSelectors.simulationButtons, container).forEach((el) => rawPool.add(el));
      } catch {}
    }

    // Sertakan juga elemen div/span/li/code/a yang berbentuk pill/tile interaktif (seperti blok kode biru pada LMS)
    const nonTileSelector =
      '.sim-output, .program-output, .console-output, .execution-result, .cell-output, .output-area, [data-sim-output], .result-box, .sim-instruction, .task-instruction, .instruction, .prompt, .reading-material';
    const genericEls = this.queryAllDeep('div, span, li, code, a', container);
    for (const el of genericEls) {
      if (rawPool.has(el)) continue;
      if (!this.isVisible(el)) continue;
      if (editorBox && (editorBox === el || editorBox.contains(el))) continue;
      if (el.matches && el.matches(nonTileSelector)) continue;
      if (el.closest && el.closest(nonTileSelector)) continue;
      if (runBtns.some((rb) => rb === el || rb.contains(el) || el.contains(rb))) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 24 || rect.width > 760 || rect.height < 18 || rect.height > 115) continue;

      const win = el.ownerDocument?.defaultView || window;
      const style = win.getComputedStyle(el);
      const isInteractive =
        style.cursor === 'pointer' ||
        style.cursor === 'grab' ||
        el.getAttribute('draggable') === 'true' ||
        el.hasAttribute('onclick') ||
        el.tabIndex >= 0 ||
        this.hasVisualPillStyle(el);

      if (isInteractive && !this.isTileWrapper(el)) {
        rawPool.add(el);
      }
    }

    // Saring kandidat yang valid
    const inlineTriggers = this.queryAllDeep('button, span, div, a, [data-inline-blank], [data-cloze]', container).filter(
      (t) => this.isInlineBlankTrigger(t)
    );

    const filteredEls = [];
    for (const el of rawPool) {
      if (!this.isVisible(el) || el.disabled) continue;
      if (this.isInsideSidebarOrHeader(el)) continue;
      if (this.isResourceOrExternalLink(el)) continue;
      if (editorBox && (editorBox === el || editorBox.contains(el))) continue;
      if (el.matches && el.matches(nonTileSelector)) continue;
      if (el.closest && el.closest(nonTileSelector)) continue;
      if (this.isPopoverContainer(el) || (el.closest && el.closest('[data-popover], [data-slot-options], .popover, .slot-popover, .blank-popover, .choice-popover, .options-popup, .balloon'))) continue;
      if (this.isInlineBlankTrigger(el)) continue;
      if (this.isPlaceholderSlotElement(el, container)) continue;
      if (this.isActionPromptElement(el, customSelectors)) continue;
      if (el.hasAttribute('data-slot-id') || el.classList.contains('py-slot-box')) continue;
      if (el.hasAttribute('data-inline-blank') || el.hasAttribute('data-cloze') || el.classList.contains('inline-blank-btn')) continue;
      if (runBtns.some((rb) => rb === el || rb.contains(el) || el.contains(rb))) continue;
      if (this.isRunButtonElement(el, customSelectors)) continue;
      if (el.closest('label') && el.closest('label').querySelector('input[type="radio"], input[type="checkbox"]')) continue;
      // Jangan pernah mengambil tombol di dalam kartu soal esai / pilihan ganda sebagai blok simulasi
      if (el.closest('.essay-question, .question-card, .quiz-question, .mcq__widget')) continue;
      if (this.isTileWrapper(el)) continue;

      // Jangan anggap tombol opsi kecil di dalam balon di bawah `[...]` sebagai blok kode utama
      if (inlineTriggers.length > 0) {
        const rect = el.getBoundingClientRect();
        const isBalloonOptionNearInlineBlank = inlineTriggers.some((trig) => {
          if (trig === el || trig.contains(el)) return true;
          const tRect = trig.getBoundingClientRect();
          const vDist = rect.top - tRect.bottom;
          const hOverlap = rect.right >= tRect.left - 110 && rect.left <= tRect.right + 110;
          return vDist >= -10 && vDist <= 95 && hOverlap && rect.width <= 120;
        });
        if (isBalloonOptionNearInlineBlank) continue;
      }

      filteredEls.push(el);
    }

    // Hilangkan elemen anak jika elemen induknya sudah menjadi kandidat tile tunggal
    // (Contoh: <span> atau slot [▪] di dalam <div class="tile"> atau <button>)
    const outerTiles = filteredEls.filter(
      (el) => !filteredEls.some((other) => other !== el && other.contains(el))
    );

    const candidateButtons = [];
    for (const btn of outerTiles) {
      const tileInfo = this.extractTileInfo(btn);
      const label = tileInfo.label;
      if (!label || label.length > 220) continue;
      // Abaikan jika seluruh elemen hanyalah slot kosong `___`
      if (/^___$/.test(label)) continue;

      // Abaikan label yang hanya berupa nomor baris / indeks cell (`[1]`, `1 2 3 4 5`), ikon menu (`≡`), atau nama bahasa tunggal
      if (/^(\[\d+\]|In\s*\[\d*\]:?|\d+(\s+\d+)*)$/i.test(label)) continue;
      if (/^[≡☰⋮×✕?+−\-▶►>›»→←<‹«]+$/.test(label)) continue;
      if (
        /^(python|python3|javascript|typescript|sql|html|css|r|bash|shell|java|c\+\+|c#|go|rust|php|ruby)$/i.test(label) &&
        tileInfo.slotCount === 0
      ) {
        continue;
      }

      // Abaikan tombol navigasi modul ("Chapter Assessment >"), tombol submit esai/kuis, atau tombol pembuka langkah ("Show both dataframes...")
      if (this.isSubmitOrNavButtonText(label) || this.isActionPromptElement(btn, customSelectors)) {
        continue;
      }

      const win = btn.ownerDocument?.defaultView || window;
      const style = win.getComputedStyle(btn);

      // Jika di dalam container ini ada kotak editor kode gelap (`editorBox`),
      // pastikan kandidat benar-benar merupakan blok kode (memiliki slot [▪], class tile kode, font monospace, atau sintaks kode),
      // BUKAN tombol navigasi/UI seperti "Chapter Assessment >" atau link referensi!
      if (editorBox) {
        const eRect = editorBox.getBoundingClientRect();
        const bRect = btn.getBoundingClientRect();
        if (bRect.top - eRect.bottom > 340 || eRect.top - bRect.bottom > 180) {
          continue;
        }
        const cls = `${btn.className || ''} ${btn.parentElement?.className || ''}`;
        const hasCodeTileClass =
          /\b(py-tile|code-tile|code-block|parsons|token|piece|snippet)\b/i.test(cls) ||
          btn.hasAttribute('data-code') ||
          btn.hasAttribute('data-tile') ||
          btn.getAttribute('draggable') === 'true';
        const isMonospace = /\b(mono|monospace|consolas|menlo|monaco|courier|fira|source\s*code|jetbrains)\b/i.test(
          style.fontFamily || ''
        );
        const hasCodeSyntax =
          tileInfo.slotCount > 0 ||
          /\b(import|from|def|return|print|for|while|if|elif|else|class|SELECT|FROM|WHERE|pd|plt|np)\b|[=()._\[\]{}#]|['"].*['"]/.test(
            label
          );

        if (!hasCodeTileClass && !isMonospace && !hasCodeSyntax) {
          continue;
        }
      }

      const btnId = this.tagElement(btn, 'sim-btn');
      const isAlreadySelected =
        btn.classList.contains('active') ||
        btn.classList.contains('selected') ||
        btn.classList.contains('pressed') ||
        btn.classList.contains('used') ||
        btn.classList.contains('is-selected') ||
        btn.classList.contains('is-used') ||
        btn.classList.contains('is-disabled') ||
        btn.classList.contains('disabled') ||
        btn.getAttribute('aria-pressed') === 'true' ||
        btn.getAttribute('data-selected') === 'true' ||
        parseFloat(style.opacity) <= 0.55 ||
        style.pointerEvents === 'none';

      candidateButtons.push({
        id: btnId,
        label,
        rawLabel: tileInfo.rawLabel,
        slotCount: tileInfo.slotCount,
        slots: tileInfo.slots,
        stepOrder: btn.getAttribute('data-step') || btn.getAttribute('data-order') || null,
        isCorrect: btn.getAttribute('data-correct') || null,
        isAlreadySelected
      });
    }

    return candidateButtons;
  },

  /**
   * Cari kontainer pembungkus terbaik untuk tombol Run / sel kode sehingga mencakup
   * baik kotak editor (`[1] python` + `▶ run`) maupun area tombol/tile kode di bawahnya,
   * tanpa pernah keluar ke seluruh halaman atau menggabungkan tombol lain seperti "Show both dataframes..." / "Submit".
   */
  findSimulationContainer(seedEl, customSelectors = {}, allRunSeedButtons = []) {
    if (!seedEl) return null;

    // Jika tombol Run ini sudah pernah diikat ke kontainer simulasi tertentu, gunakan kontainer yang sama secara konsisten!
    const boundContainerId = seedEl.getAttribute('data-lms-bound-sim-box');
    if (boundContainerId) {
      const boundEl = this.getElementById(boundContainerId);
      if (boundEl && this.isVisible(boundEl)) {
        return boundEl;
      }
    }

    const hasOtherRunBtn = (candidateEl) => {
      if (!candidateEl) return false;
      if (allRunSeedButtons.length > 1) {
        return allRunSeedButtons.some(
          (other) =>
            other !== seedEl &&
            !seedEl.contains(other) &&
            !other.contains(seedEl) &&
            candidateEl.contains(other)
        );
      }
      const otherRuns = this.queryAllDeep('button, [role="button"], div, span, a', candidateEl).filter(
        (el) => el !== seedEl && !seedEl.contains(el) && !el.contains(seedEl) && this.isRunButtonElement(el, customSelectors)
      );
      return otherRuns.length > 0;
    };

    const explicit = seedEl.closest(
      '[data-simulation], [data-task-type="simulation"], .simulation-container, .simulation-box, .interactive-lab, .lab-container, .program-runner, .code-simulation, .interactive-task, .sim-workspace, .code-builder, .notebook-exercise, .py-widget-wrap'
    );
    if (explicit && this.isVisible(explicit) && !hasOtherRunBtn(explicit)) {
      return explicit;
    }

    // Cek apakah seedEl berada di dalam kotak editor gelap (`[1] python`)
    const localEditorBox = this.findCodeEditorBox(
      seedEl.parentElement?.parentElement?.parentElement?.parentElement || document.body,
      [seedEl]
    );

    if (localEditorBox) {
      // Untuk sel kode Python, blok-blok kodenya selalu berada di sibling tepat di bawah localEditorBox
      // (1 atau maksimal 2 level di atas localEditorBox). JANGAN PERNAH naik sampai ke <article> / <main>!
      let candidateWrap = localEditorBox.parentElement;
      for (let stepUp = 0; stepUp < 2 && candidateWrap; stepUp++) {
        const tag = (candidateWrap.tagName || '').toUpperCase();
        if (tag === 'BODY' || tag === 'HTML' || tag === 'MAIN' || tag === 'ARTICLE') break;
        if (hasOtherRunBtn(candidateWrap)) break;
        if (candidateWrap.querySelectorAll('textarea, input[type="radio"]').length > 0) break;

        const tiles = this.collectCandidateTiles(candidateWrap, [seedEl], customSelectors);
        if (tiles.length > 0) {
          return candidateWrap;
        }
        candidateWrap = candidateWrap.parentElement;
      }

      // Jika sel Python tidak memiliki blok kode di bawahnya (misal kode sudah tertulis atau semua blok sudah masuk ke editor),
      // kembalikan pembungkus langsung dari localEditorBox!
      return localEditorBox.parentElement || localEditorBox;
    }

    let curr = seedEl.parentElement;
    let bestContainer = null;
    let depth = 0;

    while (curr && depth < 5) {
      const tag = curr.tagName ? curr.tagName.toUpperCase() : '';
      if (tag === 'BODY' || tag === 'HTML' || tag === 'MAIN' || tag === 'ARTICLE') break;

      if (hasOtherRunBtn(curr)) {
        break;
      }
      if (curr.querySelectorAll('textarea, input[type="radio"]').length > 0) {
        break;
      }

      const tiles = this.collectCandidateTiles(curr, [seedEl], customSelectors);
      if (tiles.length > 0) {
        bestContainer = curr;
        break;
      }

      curr = curr.parentElement;
      depth++;
    }

    if (bestContainer) return bestContainer;

    const fallback = seedEl.closest('section, .card, .module-section, .task-card, .activity-card, .panel, .workspace');
    if (fallback && !hasOtherRunBtn(fallback) && fallback.querySelectorAll('textarea, input[type="radio"]').length === 0) {
      return fallback;
    }
    return seedEl.parentElement;
  },

  /**
   * 1. Pindai Tugas Simulasi Tombol Interaktif, Susun Kode (Code-Builder), & Tombol Jalankan Program
   */
  scanSimulations(customSelectors = {}) {
    const simulations = [];

    // A. Kontainer simulasi eksplisit
    const containerSelectors = [
      '[data-simulation]',
      '[data-task-type="simulation"]',
      '.simulation-container',
      '.simulation-box',
      '.interactive-lab',
      '.lab-container',
      '.program-runner',
      '.code-simulation',
      '.interactive-task',
      '.sim-workspace',
      '.code-builder',
      '.parsons-container'
    ];

    const containers = new Set();
    for (const sel of containerSelectors) {
      this.queryAllDeep(sel).forEach((el) => {
        if (this.isVisible(el)) containers.add(el);
      });
    }

    // B. Cari semua tombol Run Program (`▶ run`, `Jalankan Program`, `Execute`, dll.)
    const potentialRunEls = this.queryAllDeep(
      'button, [role="button"], input[type="button"], a, [data-run-program], .run-program-btn, div, span'
    ).filter((el) => this.isRunButtonElement(el, customSelectors));

    // Dedup tombol Run bersarang (pilih <button> jika ada, atau elemen terdalam)
    const runSeedButtons = potentialRunEls.filter((el) => {
      const parentBtn = el.parentElement?.closest('button, [role="button"], a');
      if (parentBtn && potentialRunEls.includes(parentBtn)) return false;
      const hasChildMatch = potentialRunEls.some(
        (other) => other !== el && el.contains(other) && el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button'
      );
      return !hasChildMatch;
    });

    for (const runBtn of runSeedButtons) {
      const parentContainer = this.findSimulationContainer(runBtn, customSelectors, runSeedButtons);
      if (parentContainer) {
        let handled = false;
        for (const existing of Array.from(containers)) {
          // Hanya gabungkan jika keduanya mengacu pada tombol Run yang sama
          const existingRuns = runSeedButtons.filter((rb) => existing.contains(rb));
          const parentRuns = runSeedButtons.filter((rb) => parentContainer.contains(rb));
          const sameRunSet =
            existingRuns.length === parentRuns.length &&
            existingRuns.every((rb) => parentRuns.includes(rb));

          if (existing === parentContainer || (existing.contains(parentContainer) && sameRunSet)) {
            handled = true;
            break;
          }
          if (parentContainer.contains(existing) && sameRunSet) {
            containers.delete(existing);
          }
        }
        if (!handled) {
          containers.add(parentContainer);
        }
      }
    }

    // C. Deteksi widget Code-Cell / Code-Builder (`[1] python` + nomor baris `1 2 3` + blok kode di bawahnya)
    //    meskipun tombol `▶ run` belum muncul atau tersembunyi
    if (containers.size === 0) {
      const codeHeaders = this.queryAllDeep('div, span, header').filter((el) => {
        if (!this.isVisible(el)) return false;
        const t = this.cleanText(el.innerText || '');
        return /^(python|python3|javascript|sql|r)$/i.test(t);
      });
      for (const hdr of codeHeaders) {
        const box = this.findSimulationContainer(hdr, customSelectors);
        if (box && this.collectCandidateTiles(box, [], customSelectors).length >= 2) {
          containers.add(box);
        }
      }
    }

    let simIdx = 1;
    for (const container of containers) {
      const taskId = this.tagElement(container, `sim-box-${simIdx++}`);

      // Kumpulkan tombol Run di dalam kontainer ini & ikat ke taskId agar tidak pernah berpindah kontainer
      const containerRunEls = runSeedButtons.filter((rb) => container.contains(rb));
      containerRunEls.forEach((rb) => rb.setAttribute('data-lms-bound-sim-box', taskId));
      const runButtons = containerRunEls.map((rb) => ({
        id: this.tagElement(rb, 'run-btn'),
        label: this.cleanText(
          rb.innerText || rb.value || rb.getAttribute('aria-label') || rb.getAttribute('title') || 'Run'
        )
      }));

      // Kumpulkan semua tombol langkah / blok kode kandidat
      const candidateButtons = this.collectCandidateTiles(container, containerRunEls, customSelectors);

      // Identifikasi kotak editor kode (untuk target drop atau pemantauan baris kode)
      const editorBox = this.findCodeEditorBox(container, containerRunEls);
      const editorDropzoneId = editorBox ? this.tagElement(editorBox, 'editor-box') : null;

      // Ekstrak instruksi tugas di dalam (atau tepat di atas) kontainer simulasi
      const instructionEls = this.queryAllDeep(
        '.sim-instruction, .task-instruction, .instruction, .prompt, [data-instruction], h2, h3, h4, p, ol, ul, .alert, .callout',
        container
      );
      const instructionParts = [];
      instructionEls.forEach((el) => {
        if (editorBox && editorBox.contains(el)) return;
        if (containerRunEls.some((rb) => rb.contains(el) || el.contains(rb))) return;
        if (candidateButtons.some((cb) => {
          const bEl = this.getElementById(cb.id);
          return bEl && (bEl.contains(el) || el.contains(bEl));
        })) return;
        const txt = this.cleanText(el.innerText);
        if (txt && txt.length > 5 && !instructionParts.includes(txt)) {
          instructionParts.push(txt);
        }
      });

      // Jika di dalam container tidak ada teks instruksi (hanya kotak kode & blok), cek elemen tepat sebelum container
      if (instructionParts.length === 0 && container.previousElementSibling) {
        const prevTxt = this.cleanText(container.previousElementSibling.innerText || '');
        if (prevTxt.length > 5 && prevTxt.length < 800) {
          instructionParts.push(prevTxt);
        }
      }

      const instruction =
        instructionParts.join(' | ').slice(0, 1500) ||
        this.cleanText(container.innerText).slice(0, 800);

      // Cek apakah tugas ini bertipe penyusunan kode (Code-Builder / Parsons / Fill-in-the-blank)
      const codePattern = /\b(import\s+\w+|from\s+\w+\s+import|def\s+\w+|return\b|print\s*\(|\.read_csv|\.DataFrame|\.plot\(|plt\.|pd\.|np\.|SELECT\s+)\b|#\s*\w+|___\s*\.|\w+\s*=\s*[\w_]/i;
      const isCodeBuilder =
        Boolean(editorBox) ||
        candidateButtons.some((b) => b.slotCount > 0 || codePattern.test(b.label || ''));

      // Cari elemen output/status program di dalam kontainer simulasi
      const outputEl = container.querySelector(
        '.sim-output, .program-output, .console-output, .execution-result, .cell-output, .output-area, [data-sim-output], .result-box'
      ) || editorBox;
      const outputId = outputEl ? this.tagElement(outputEl, 'sim-out') : null;
      const statusEval = this.evaluateSimulationStatus(
        { taskType: isCodeBuilder ? 'code-builder' : 'button-sequence', candidateButtons },
        container,
        editorBox,
        outputEl,
        customSelectors,
        true
      );
      const isCompleted =
        container.getAttribute('data-lms-completed') === 'true' ||
        Boolean(editorBox && editorBox.getAttribute('data-lms-completed') === 'true') ||
        (containerRunEls.length > 0 &&
          containerRunEls.every((rb) => rb.getAttribute('data-lms-completed') === 'true')) ||
        Boolean(container.closest && container.closest('[data-lms-completed="true"]')) ||
        (!statusEval.isWrong &&
          !statusEval.isIncomplete &&
          (container.getAttribute('data-completed') === 'true' ||
            container.classList.contains('completed') ||
            container.classList.contains('is-complete') ||
            (outputEl &&
              outputEl !== editorBox &&
              /\b(berhasil|sukses|success|completed|passed|100%)\b/i.test(outputEl.innerText || ''))));

      if (candidateButtons.length > 0 || runButtons.length > 0) {
        simulations.push({
          taskId,
          taskType: isCodeBuilder ? 'code-builder' : 'button-sequence',
          instruction,
          candidateButtons,
          runButtons,
          editorDropzoneId,
          outputId,
          isCompleted
        });
      }
    }

    return simulations;
  },

  /**
   * Cek apakah suatu elemen ditandai salah (error / incorrect / warna merah) oleh LMS
   */
  isElementMarkedWrong(el) {
    if (!el || el.nodeType !== 1) return false;
    const checkTarget = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const cls = `${node.className || ''} ${node.getAttribute('data-status') || ''} ${node.getAttribute('data-state') || ''}`;
      if (/\b(incorrect|is-incorrect|wrong|is-wrong|error|has-error|invalid|is-invalid|failed|danger)\b/i.test(cls)) {
        return true;
      }
      if (
        node.getAttribute('aria-invalid') === 'true' ||
        node.getAttribute('data-correct') === 'false'
      ) {
        return true;
      }
      const win = node.ownerDocument?.defaultView || window;
      const style = win.getComputedStyle(node);
      for (const prop of [style.borderColor, style.backgroundColor, style.color, style.outlineColor]) {
        const m = (prop || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
          const r = Number(m[1]);
          const g = Number(m[2]);
          const b = Number(m[3]);
          // Deteksi warna merah terang khas pesan error/salah
          if (r >= 190 && g <= 105 && b <= 105) {
            return true;
          }
        }
      }
      return false;
    };

    return checkTarget(el) || checkTarget(el.parentElement);
  },

  /**
   * Cek apakah seluruh blok kode yang diharapkan sudah berada di dalam kotak editor gelap (`editorBoxEl`)
   */
  areCodeBlocksInsideEditor(simScan, editorBoxEl) {
    if (!editorBoxEl) return { allPlaced: true, placedCount: 0, expectedCount: 0 };
    const editorText = this.cleanText(editorBoxEl.innerText || '');
    const candidates = (simScan?.candidateButtons || []).filter(
      (b) => !/\b(reset|batal|cancel|clear|hapus)\b/i.test(b.label || '')
    );
    if (candidates.length === 0) return { allPlaced: true, placedCount: 0, expectedCount: 0 };

    let placedCount = 0;
    for (const c of candidates) {
      // Ambil potongan teks tetap terpanjang dari label blok kode (di luar `___`)
      const fragments = (c.label || '')
        .split('___')
        .map((s) => this.cleanText(s))
        .filter((s) => s.length >= 2)
        .sort((a, b) => b.length - a.length);

      const keyFragment = fragments[0] || '';
      if (!keyFragment || editorText.includes(keyFragment)) {
        placedCount++;
      }
    }

    return {
      allPlaced: placedCount >= candidates.length,
      placedCount,
      expectedCount: candidates.length
    };
  },

  /**
   * Evaluasi apakah simulasi benar-benar selesai dengan tepat atau justru SALAH / belum lengkap
   */
  evaluateSimulationStatus(simScan, containerEl, editorBoxEl, outputEl, customSelectors = {}, isInitialScan = false, skipInlineBlanks = false) {
    if (!containerEl) {
      return { ok: false, isWrong: false, isIncomplete: true, reason: 'Kontainer simulasi tidak ditemukan' };
    }

    const errorTextRegex =
      /(?:\[error\]|\b(?:traceback|syntaxerror|nameerror|typeerror|valueerror|indentationerror|keyerror|indexerror|attributeerror|zerodivisionerror|incorrect|not\s+quite\s+right|that's\s+not\s+correct|that\s+is\s+not\s+correct|wrong\s+answer|try\s+again|belum\s+tepat|kurang\s+tepat|jawaban\s+salah|masih\s+salah|coba\s+lagi|gagal\s+dijalankan)\b|masih\s+ada\s+.*belum\s+diisi|urutan\s+.*belum\s+tepat)/i;

    // 1. Cek teks output / pesan feedback di dalam kontainer simulasi
    const feedbackEls = this.queryAllDeep(
      '.sim-output, .program-output, .console-output, .execution-result, .cell-output, .output-area, [data-sim-output], .result-box, .feedback, .error-message, .alert, [role="alert"]',
      containerEl
    ).filter((el) => this.isVisible(el));

    if (outputEl && this.isVisible(outputEl) && !feedbackEls.includes(outputEl)) {
      feedbackEls.push(outputEl);
    }

    for (const fEl of feedbackEls) {
      if (fEl === editorBoxEl) continue;
      const txt = this.cleanText(fEl.innerText || '');
      if (errorTextRegex.test(txt)) {
        return {
          ok: false,
          isWrong: true,
          isIncomplete: false,
          reason: txt.slice(0, 110)
        };
      }
      if (!isInitialScan && this.isElementMarkedWrong(fEl) && !/\b(berhasil|passed|100%|success|correct)\b/i.test(txt)) {
        return {
          ok: false,
          isWrong: true,
          isIncomplete: false,
          reason: txt.slice(0, 110) || 'Output simulasi menunjukkan status salah/error'
        };
      }
    }

    // 2. Cek elemen berstatus incorrect/error di dalam kontainer simulasi
    const wrongEls = this.queryAllDeep(
      '.is-incorrect, .incorrect, .is-wrong, .wrong-answer, .has-error, .error-message, .alert-danger, [data-correct="false"], [aria-invalid="true"]',
      containerEl
    ).filter((el) => this.isVisible(el));

    if (wrongEls.length > 0) {
      const msg = this.cleanText(wrongEls[0].innerText || '') || 'Jawaban simulasi ditandai salah (incorrect)';
      return {
        ok: false,
        isWrong: true,
        isIncomplete: false,
        reason: msg.slice(0, 110)
      };
    }

    // 3. Cek apakah masih ada slot `[▪]` yang belum diisi di dalam editor kode
    if (editorBoxEl) {
      const unfilledInEditor = this.findUnfilledSlotsInScope(editorBoxEl);
      if (unfilledInEditor.length > 0) {
        return {
          ok: false,
          isWrong: false,
          isIncomplete: true,
          reason: `Masih ada ${unfilledInEditor.length} pilihan slot di dalam blok program yang belum diisi`
        };
      }
    }

    // 4. Untuk Code-Builder (`[1] python`), pastikan baris kode sudah masuk ke dalam editor (dan tidak di-reset ke kosong oleh LMS)
    if (simScan?.taskType === 'code-builder' && !isInitialScan && editorBoxEl) {
      const placement = this.areCodeBlocksInsideEditor(simScan, editorBoxEl);
      if (placement.expectedCount > 0 && placement.placedCount === 0) {
        return {
          ok: false,
          isWrong: true,
          isIncomplete: true,
          isReset: true,
          reason: 'Blok program di-reset atau belum masuk ke editor karena urutan/isian salah'
        };
      }
      if (!placement.allPlaced) {
        return {
          ok: false,
          isWrong: false,
          isIncomplete: true,
          reason: `Baru ${placement.placedCount}/${placement.expectedCount} blok program yang masuk ke editor`
        };
      }
    }

    // 5. Cek apakah ada pertanyaan rumpang hasil program (`There are [...] rows of data...`) di dalam kontainer ini yang masih kosong atau salah
    if (!isInitialScan && !skipInlineBlanks) {
      const inlineTriggers = this.queryAllDeep(
        'button, span, div, a, select, [data-inline-blank], [data-cloze]',
        containerEl
      ).filter((el) => this.isVisible(el) && (el.tagName === 'SELECT' || this.isInlineBlankTrigger(el)));

      for (const trig of inlineTriggers) {
        if (this.isSlotUnfilled(trig)) {
          return {
            ok: false,
            isWrong: false,
            isIncomplete: true,
            hasUnfilledBlanks: true,
            reason: 'Pilihan hasil program ([...]) belum terjawab'
          };
        }
        if (this.isElementMarkedWrong(trig)) {
          return {
            ok: false,
            isWrong: true,
            isIncomplete: false,
            hasWrongBlanks: true,
            reason: 'Pilihan pada hasil program ([...]) bernilai salah'
          };
        }
      }
    }

    return {
      ok: true,
      isWrong: false,
      isIncomplete: false,
      reason: 'Simulasi berhasil diselesaikan dengan benar'
    };
  },

  /**
   * Cari tombol Reset / Clear / Try Again di dalam kontainer simulasi (termasuk menu `≡` pada sel Python)
   */
  findResetButtonInContainer(containerEl) {
    if (!containerEl) return null;
    const resetRegex = /\b(reset|ulangi|coba\s*lagi|try\s*again|retry|clear|mulai\s*ulang|start\s*over)\b/i;
    const allClickables = this.queryAllDeep('button, [role="button"], a, span, div', containerEl).filter((el) =>
      this.isVisible(el)
    );
    for (const el of allClickables) {
      const txt = this.cleanText(
        el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || ''
      );
      if (resetRegex.test(txt) && txt.length <= 40) {
        return el;
      }
    }
    return null;
  },

  /**
   * Ekstrak fakta dari hasil eksekusi program (tabel DataFrame, jumlah baris, jumlah kolom, indeks terakhir, teks output)
   */
  extractOutputFacts(scopeEl = document) {
    const root = scopeEl || document;
    const outputContainers = this.queryAllDeep(
      '.sim-output, .program-output, .console-output, .execution-result, .cell-output, .output-area, [data-sim-output], .result-box, .dataframe, table, pre',
      root
    ).filter((el) => this.isVisible(el));

    const rawTextParts = [];
    outputContainers.forEach((el) => {
      const t = this.cleanText(el.innerText || '');
      if (t) rawTextParts.push(t);
    });
    const rawText = rawTextParts.join('\n') || this.cleanText((root.innerText || '').slice(0, 4000));

    let explicitRows = null;
    let explicitCols = null;

    // Cari pola seperti "35 rows x 4 columns", "35 rows", "35 baris"
    const rowMatch =
      rawText.match(/\b(\d+)\s*(?:rows|baris)\b/i) ||
      rawText.match(/\((\d+)\s*rows/i);
    if (rowMatch) {
      explicitRows = Number(rowMatch[1]);
    }

    const colMatch =
      rawText.match(/\b(\d+)\s*(?:columns|cols|kolom)\b/i) ||
      rawText.match(/×\s*(\d+)\s*columns/i);
    if (colMatch) {
      explicitCols = Number(colMatch[1]);
    }

    // Analisis elemen <table> jika output merender tabel DataFrame
    let tableRowCount = null;
    let tableColCount = null;
    let lastIndexValue = null;
    let inferredRowsFromZeroIndex = null;

    const tables = this.queryAllDeep('table', root).filter((t) => this.isVisible(t));
    if (tables.length > 0) {
      const tbl = tables[tables.length - 1];
      const bodyRows = Array.from(tbl.querySelectorAll('tbody tr'));
      const allRows = bodyRows.length > 0 ? bodyRows : Array.from(tbl.querySelectorAll('tr')).slice(1);
      if (allRows.length > 0) {
        tableRowCount = allRows.length;
        const lastRow = allRows[allRows.length - 1];
        const firstCell = lastRow.querySelector('th, td');
        if (firstCell) {
          const idxNum = parseInt(this.cleanText(firstCell.innerText || ''), 10);
          if (!Number.isNaN(idxNum) && idxNum >= 0) {
            lastIndexValue = idxNum;
            inferredRowsFromZeroIndex = idxNum + 1;
          }
        }
        const dataCells = lastRow.querySelectorAll('td');
        if (dataCells.length > 0) {
          tableColCount = dataCells.length;
        }
      }
    }

    // Jika bukan <table>, cek baris teks terakhir yang diawali angka indeks (0, 1, ... 34)
    if (lastIndexValue === null) {
      const lines = rawText.split(/\n+/);
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].trim().match(/^(\d+)\s+\S+/);
        if (m) {
          const idxNum = parseInt(m[1], 10);
          if (!Number.isNaN(idxNum)) {
            lastIndexValue = idxNum;
            inferredRowsFromZeroIndex = idxNum + 1;
            break;
          }
        }
      }
    }

    const numbersInOutput = Array.from(
      new Set((rawText.match(/\b\d+(?:\.\d+)?\b/g) || []).map((n) => Number(n)))
    );

    return {
      rawText,
      explicitRows,
      explicitCols,
      tableRowCount,
      tableColCount,
      lastIndexValue,
      inferredRowsFromZeroIndex,
      numbersInOutput
    };
  },

  /**
   * 1B. Pindai Pertanyaan Rumpang / Popover Pilihan Hasil Program (seperti `There are [...] rows of data...`)
   */
  scanInlineBlanks(customSelectors = {}, simulations = [], scopeEl = document) {
    const blanks = [];
    const tileElSet = new Set();
    const tileIdSet = new Set();

    // Kumpulkan semua elemen tile blok kode agar slot di dalam blok kode tidak dikira inline blank kalimat
    for (const sim of simulations) {
      for (const cb of sim.candidateButtons || []) {
        tileIdSet.add(cb.id);
        const bEl = this.getElementById(cb.id);
        if (bEl) tileElSet.add(bEl);
      }
    }

    const allEls = this.queryAllDeep('button, span, div, a, select, [data-inline-blank], [data-cloze]', scopeEl || document);
    const triggerEls = [];

    for (const el of allEls) {
      if (!this.isVisible(el)) continue;
      if (this.isInsideSidebarOrHeader(el)) continue;
      if (Array.from(tileElSet).some((t) => t === el || t.contains(el))) continue;

      if (el.tagName === 'SELECT') {
        if (!el.closest('#lms-autopilot-hud-host, nav, header, footer')) {
          triggerEls.push(el);
        }
        continue;
      }

      if (this.isInlineBlankTrigger(el)) {
        triggerEls.push(el);
      }
    }

    let bIdx = 1;
    for (const trig of triggerEls) {
      const blankId = this.tagElement(trig, `inline-blank-${bIdx++}`);
      const sentenceEl =
        trig.closest('p, li, .question-text, .cloze-sentence, .output-question, .post-run-question, div') ||
        trig.parentElement;

      // Bangun teks kalimat dengan mengganti posisi trigger menjadi `___`
      let sentenceContext = '';
      if (sentenceEl) {
        const parts = [];
        const walkSentence = (node) => {
          if (!node) return;
          if (node === trig) {
            parts.push(' ___ ');
            return;
          }
          if (node.nodeType === 1 && this.isPopoverContainer(node)) return;
          if (node.nodeType === 3) {
            parts.push(node.nodeValue || '');
            return;
          }
          for (const child of node.childNodes) {
            walkSentence(child);
          }
        };
        walkSentence(sentenceEl);
        sentenceContext = this.cleanText(parts.join(''));
      }

      const rawDataOpts = trig.getAttribute('data-options') || '';
      const attrOptions = rawDataOpts
        ? rawDataOpts.split('|').map((s) => s.trim()).filter(Boolean)
        : [];

      const openPopoverOpts = this.findPopoverOptionsForTarget(trig, null, tileIdSet, null, false);
      const isFilled = !this.isSlotUnfilled(trig) && !this.isElementMarkedWrong(trig);

      blanks.push({
        blankId,
        sentenceContext: sentenceContext || 'There are ___ rows of data',
        attrOptions,
        openOptions: openPopoverOpts.map((o) => ({ id: o.id, text: o.text })),
        isFilled
      });
    }

    return blanks;
  },

  /**
   * 1C. Pindai Tombol Aksi / Pembuka Langkah Interaktif / Peluncur Modul (Start / Resume / Launch / Continue / Accordion)
   *     (Contoh: "Start Course", "Start Module", "Start Quiz", "Launch", "Resume", "Click here to...", "Show both dataframes...")
   */
  scanActionPrompts(customSelectors = {}, simulations = []) {
    const prompts = [];
    const candidates = this.queryAllDeep('button, [role="button"], a, div, span');
    const matchedEls = [];

    for (const el of candidates) {
      if (el.getAttribute('data-lms-completed') === 'true') continue;
      if (el.closest && el.closest('[data-lms-completed="true"]')) continue;
      if (!this.isActionPromptElement(el, customSelectors)) continue;
      matchedEls.push(el);
    }

    // Pilih elemen terdalam jika ada wrapper yang memiliki teks serupa
    const leafPrompts = matchedEls.filter(
      (el) => !matchedEls.some((other) => other !== el && el.contains(other))
    );

    let pIdx = 1;
    for (const el of leafPrompts) {
      const promptId = this.tagElement(el, `action-prompt-${pIdx++}`);
      const label = this.cleanText(el.innerText || el.value || 'Click here');
      prompts.push({
        promptId,
        label,
        isCompleted: el.getAttribute('data-lms-completed') === 'true'
      });
    }

    // Tambahan: Deteksi Accordion / Tab / Flip-card yang belum dibuka (`aria-expanded="false"`) di area materi utama (seperti pada modul AWS / Rise 360)
    const accordions = this.queryAllDeep(
      'button[aria-expanded="false"], [role="button"][aria-expanded="false"], .blocks-accordion__header[aria-expanded="false"], .accordion-button.collapsed'
    ).filter((el) => {
      if (!this.isVisible(el) || this.isInsideSidebarOrHeader(el)) return false;
      if (el.getAttribute('data-lms-completed') === 'true') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 24 || rect.height > 120) return false;
      const txt = this.cleanText(el.innerText || el.getAttribute('aria-label') || '');
      if (!txt || txt.length < 3 || txt.length > 140) return false;
      if (/\b(menu|navigation|sidebar|outline|filter|search|profile|account|settings|help)\b/i.test(txt)) return false;
      return true;
    });

    for (const acc of accordions.slice(0, 6)) {
      if (prompts.some((p) => this.getElementById(p.promptId) === acc)) continue;
      const promptId = this.tagElement(acc, `action-prompt-${pIdx++}`);
      const label = this.cleanText(acc.innerText || acc.getAttribute('aria-label') || 'Expand section');
      prompts.push({
        promptId,
        label,
        isCompleted: false
      });
    }

    return prompts;
  },

  /**
   * 1D. Pindai Materi Video (`<video>` HTML5 / Video.js / JWPlayer di AWS Skill Builder, Canvas, Coursera, dll.)
   *     agar video yang belum selesai dapat diputar & dipercepat / diselesaikan otomatis sebelum pindah ke modul berikutnya!
   */
  scanVideos() {
    const videos = [];
    const videoEls = this.queryAllDeep('video').filter(
      (v) => this.isVisible(v) && !this.isInsideSidebarOrHeader(v)
    );

    let vIdx = 1;
    for (const v of videoEls) {
      const videoId = this.tagElement(v, `video-${vIdx++}`);
      const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      const currentTime = Number.isFinite(v.currentTime) ? v.currentTime : 0;
      const isCompleted =
        v.getAttribute('data-lms-completed') === 'true' ||
        Boolean(v.ended) ||
        (duration > 2 && currentTime >= duration - 1.5);

      videos.push({
        videoId,
        duration,
        currentTime,
        isCompleted
      });
    }

    return videos;
  },

  /**
   * Normalisasi teks lencana huruf opsi pilihan ganda (misal 'A', '(B)', 'C.', 'Ⓐ' -> 'A'..'F')
   */
  parseOptionBadgeLetter(rawStr) {
    const t = this.cleanText(rawStr).replace(/^['"]|['"]$/g, '');
    if (!t || t.length > 4) return null;
    const circledMap = {
      'Ⓐ': 'A', 'Ⓑ': 'B', 'Ⓒ': 'C', 'Ⓓ': 'D', 'Ⓔ': 'E', 'Ⓕ': 'F',
      'ⓐ': 'A', 'ⓑ': 'B', 'ⓒ': 'C', 'ⓓ': 'D', 'ⓔ': 'E', 'ⓕ': 'F'
    };
    if (circledMap[t]) return circledMap[t];
    const m = t.match(/^\(?([A-Fa-f])\)?[\.\):]?$/);
    if (!m) return null;
    return m[1].toUpperCase();
  },

  /**
   * Cek apakah suatu elemen merupakan lencana huruf opsi ('A', 'B', 'C', 'D', 'Ⓐ', dst.)
   */
  getBadgeLetterFromElement(el) {
    if (!el || el.nodeType !== 1 || !this.isVisible(el)) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 12 || rect.width > 68 || rect.height < 12 || rect.height > 68) return null;
    if (el.children.length > 4) return null;

    const rawText =
      (typeof el.innerText === 'string' ? el.innerText : '') ||
      el.textContent ||
      el.getAttribute('aria-label') ||
      el.getAttribute('data-letter') ||
      el.getAttribute('data-option') ||
      el.getAttribute('data-choice') ||
      '';

    const directLetter = this.parseOptionBadgeLetter(rawText);
    if (directLetter) {
      // Jika huruf berasal dari kata biasa di dalam kalimat, abaikan kecuali elemen memang berbentuk badge/lingkaran/kotak kecil
      const win = el.ownerDocument?.defaultView || window;
      const style = win.getComputedStyle(el);
      const isSquareOrRound = Math.abs(rect.width - rect.height) <= 22;
      const tag = (el.tagName || '').toUpperCase();
      const hasBorderOrBg =
        parseFloat(style.borderTopWidth) > 0 ||
        parseFloat(style.borderRadius) >= 4 ||
        (style.backgroundColor &&
          style.backgroundColor !== 'transparent' &&
          !/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0(?:\.0+)?\s*\)/.test(style.backgroundColor));
      if (
        isSquareOrRound &&
        (hasBorderOrBg || ['SPAN', 'DIV', 'BUTTON', 'SVG', 'LABEL', 'I', 'B', 'STRONG'].includes(tag))
      ) {
        return directLetter;
      }
    }

    // Cek juga pseudo-element ::before & ::after (sering dipakai untuk merender huruf A, B, C, D)
    try {
      const win = el.ownerDocument?.defaultView || window;
      for (const pseudo of ['::before', '::after']) {
        const pContent = win.getComputedStyle(el, pseudo)?.content || '';
        if (pContent && pContent !== 'none' && pContent !== 'normal') {
          const pLetter = this.parseOptionBadgeLetter(pContent);
          if (pLetter) return pLetter;
        }
      }
    } catch {}

    return null;
  },

  /**
   * Deteksi apakah elemen adalah kotak baris program / pill kode gelap (seperti `df.query('count == 16')`)
   */
  isDarkCodePillElement(el) {
    if (!el || el.nodeType !== 1 || !this.isVisible(el)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 65 || rect.height < 18 || rect.height > 115) return false;

    const txt = this.cleanText(el.innerText || el.textContent || '');
    if (!txt || txt.length < 2 || txt.length > 260) return false;
    if (this.isSubmitOrNavButtonText(txt)) return false;

    const win = el.ownerDocument?.defaultView || window;
    const style = win.getComputedStyle(el);
    const bg = style.backgroundColor || '';
    const rgbMatch = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (rgbMatch) {
      const r = Number(rgbMatch[1]);
      const g = Number(rgbMatch[2]);
      const b = Number(rgbMatch[3]);
      const a = rgbMatch[4] !== undefined ? Number(rgbMatch[4]) : 1;
      if (a >= 0.5 && r < 75 && g < 75 && b < 85) {
        return true;
      }
    }

    const tag = (el.tagName || '').toUpperCase();
    if ((tag === 'PRE' || tag === 'CODE') && this.hasVisualPillStyle(el)) {
      return true;
    }
    return false;
  },

  /**
   * Cek apakah elemen opsi PG (atau anak di dalamnya) sedang berstatus terpilih (selected / checked).
   * PENTING: Jangan gunakan class generik `.active` karena elemen interaktif/token kode sering memakai `.active` meski belum dipilih.
   */
  isOptionElementSelected(optEl) {
    if (!optEl || optEl.nodeType !== 1) return false;
    const checkNode = (node) => {
      if (!node || node.nodeType !== 1) return false;
      if (node.checked === true) return true;
      if (
        node.getAttribute('aria-checked') === 'true' ||
        node.getAttribute('aria-selected') === 'true' ||
        node.getAttribute('data-selected') === 'true' ||
        node.getAttribute('data-lms-selected') === 'true'
      ) {
        return true;
      }
      const cls = node.className && typeof node.className === 'string' ? node.className : '';
      return /\b(selected|is-selected|checked|is-checked|chosen|is-chosen)\b/i.test(cls);
    };

    if (checkNode(optEl)) return true;
    const descendants = optEl.querySelectorAll ? Array.from(optEl.querySelectorAll('*')) : [];
    return descendants.some(checkNode);
  },

  /**
   * Pecah sekumpulan elemen opsi yang berada di dalam 1 kontainer besar (misal 9 soal = 36 opsi di dalam satu kartu Assessment)
   * menjadi grup-grup per soal (masing-masing 2..6 opsi) berdasarkan urutan vertikal, reset huruf A, atau celah antarsoal.
   */
  splitOptionElementsIntoQuestionGroups(optionEls) {
    if (!Array.isArray(optionEls) || optionEls.length < 2) return [];
    const sorted = [...optionEls].sort((a, b) => {
      const rA = a.getBoundingClientRect();
      const rB = b.getBoundingClientRect();
      return rA.top - rB.top || rA.left - rB.left;
    });

    if (sorted.length <= 6) {
      // Cek apakah di dalam <= 6 opsi ini sebenarnya ada 2 soal (misal A, B, C lalu A, B, C atau celah vertikal > 70px)
      const subGroups = [];
      let currGroup = [sorted[0]];
      for (let i = 1; i < sorted.length; i++) {
        const prevRect = sorted[i - 1].getBoundingClientRect();
        const currRect = sorted[i].getBoundingClientRect();
        const gapY = currRect.top - prevRect.bottom;
        const txt = this.cleanText(sorted[i].innerText || sorted[i].textContent || '');
        const startsWithA = /^(?:\(?A\)?[\.\):]|Ⓐ)\s+/i.test(txt);
        if ((startsWithA && currGroup.length >= 2) || (gapY > 75 && currGroup.length >= 2)) {
          subGroups.push(currGroup);
          currGroup = [sorted[i]];
        } else {
          currGroup.push(sorted[i]);
        }
      }
      if (currGroup.length >= 2) subGroups.push(currGroup);
      return subGroups.length > 0 ? subGroups : [sorted];
    }

    // Jika > 6 opsi, kelompokkan terlebih dahulu berdasarkan parent terdekat yang hanya membungkus 2..6 opsi
    const parentBuckets = new Map();
    const unbucketed = [];
    for (const el of sorted) {
      let tightParent = null;
      let p = el.parentElement;
      for (let d = 0; d < 4 && p; d++) {
        const countInP = sorted.filter((other) => p.contains(other)).length;
        if (countInP >= 2 && countInP <= 6) {
          tightParent = p;
          break;
        }
        if (countInP > 6) break;
        p = p.parentElement;
      }
      if (tightParent) {
        if (!parentBuckets.has(tightParent)) parentBuckets.set(tightParent, []);
        parentBuckets.get(tightParent).push(el);
      } else {
        unbucketed.push(el);
      }
    }

    const resultGroups = [];
    for (const [, grp] of parentBuckets.entries()) {
      if (grp.length >= 2) resultGroups.push(grp);
    }

    if (unbucketed.length >= 2) {
      let currGroup = [unbucketed[0]];
      for (let i = 1; i < unbucketed.length; i++) {
        const prevRect = unbucketed[i - 1].getBoundingClientRect();
        const currRect = unbucketed[i].getBoundingClientRect();
        const gapY = currRect.top - prevRect.bottom;
        const txt = this.cleanText(unbucketed[i].innerText || unbucketed[i].textContent || '');
        const startsWithA = /^(?:\(?A\)?[\.\):]|Ⓐ)\s+/i.test(txt);

        if (
          (startsWithA && currGroup.length >= 2) ||
          (gapY > 48 && currGroup.length >= 2) ||
          currGroup.length >= 6
        ) {
          resultGroups.push(currGroup);
          currGroup = [unbucketed[i]];
        } else {
          currGroup.push(unbucketed[i]);
        }
      }
      if (currGroup.length >= 2) {
        resultGroups.push(currGroup);
      }
    }

    resultGroups.sort((gA, gB) => gA[0].getBoundingClientRect().top - gB[0].getBoundingClientRect().top);
    return resultGroups;
  },

  /**
   * 2. Pindai Soal Pilihan Ganda (Radio, Checkbox, Kartu Opsi Kustom, Opsi Berlabel A/B/C/D, dan Opsi Baris Kode Gelap)
   * Mendukung penuh halaman Assessment dengan banyak soal (misal 9 soal sekaligus dalam 1 kartu/halaman).
   */
  scanMCQs(customSelectors = {}, simulations = []) {
    const rawMcqs = [];
    const processedOptionEls = new Set();
    const simContainers = simulations
      .map((s) => this.getElementById(s.taskId))
      .filter(Boolean);

    const markOptionProcessed = (el) => {
      if (!el) return;
      processedOptionEls.add(el);
    };
    const isElementInProcessedMCQ = (el) => {
      if (!el) return true;
      for (const o of processedOptionEls) {
        if (o === el || o.contains(el) || el.contains(o)) return true;
      }
      return false;
    };

    // A. Input Radio & Checkbox Standar (termasuk ketika <input> disembunyikan dengan CSS dan dibungkus oleh baris/label yang terlihat)
    const inputs = this.queryAllDeep('input[type="radio"], input[type="checkbox"]').filter(
      (el) => !el.closest('#lms-autopilot-hud-host') && !el.disabled && !this.isInsideSidebarOrHeader(el)
    );

    const rawInputGroups = new Map();
    for (const input of inputs) {
      if (input.closest('nav, header, footer')) continue;

      // Cari ancestor terdekat yang hanya memiliki 2..6 input (jangan mengambil kartu besar yang membungkus 9 soal / 36 input!)
      let tightGroupContainer = null;
      let curr = input.parentElement;
      for (let d = 0; d < 6 && curr; d++) {
        if (curr.tagName === 'BODY' || curr.tagName === 'HTML') break;
        const count = curr.querySelectorAll('input[type="radio"], input[type="checkbox"]').length;
        if (count >= 2 && count <= 6) {
          tightGroupContainer = curr;
          break;
        }
        if (count > 6) break;
        curr = curr.parentElement;
      }

      const groupKey =
        (input.name &&
        inputs.filter((other) => other.name === input.name).length >= 2 &&
        inputs.filter((other) => other.name === input.name).length <= 6
          ? `name:${input.name}`
          : null) ||
        (tightGroupContainer ? this.tagElement(tightGroupContainer, 'mcq-grp') : null) ||
        (input.name ? `name:${input.name}` : this.tagElement(input.parentElement, 'mcq-grp'));

      if (!rawInputGroups.has(groupKey)) {
        rawInputGroups.set(groupKey, []);
      }
      rawInputGroups.get(groupKey).push(input);
    }

    // Jika ada grup input yang memiliki > 6 input (misal 36 radio di satu form tanpa atribut name berbeda), pecah per soal!
    const finalInputGroups = [];
    for (const [, grpInputs] of rawInputGroups.entries()) {
      if (grpInputs.length < 2) continue;
      if (grpInputs.length <= 6) {
        finalInputGroups.push(grpInputs);
      } else {
        for (let i = 0; i < grpInputs.length; i += 4) {
          const slice = grpInputs.slice(i, i + 4);
          if (slice.length >= 2) finalInputGroups.push(slice);
        }
      }
    }

    let qIndex = 1;
    for (const groupInputs of finalInputGroups) {
      if (groupInputs.length < 2) continue;

      const firstInput = groupInputs[0];
      let questionContainer = null;
      let curr = firstInput.parentElement;
      for (let d = 0; d < 6 && curr; d++) {
        if (curr.tagName === 'BODY' || curr.tagName === 'HTML') break;
        if (groupInputs.every((inp) => curr.contains(inp))) {
          questionContainer = curr;
          break;
        }
        curr = curr.parentElement;
      }

      const resolvedOptions = [];
      const optDomElements = [];

      for (const inp of groupInputs) {
        const doc = inp.ownerDocument || document;
        let labelEl =
          inp.closest('label') ||
          (inp.id ? doc.querySelector(`label[for="${CSS.escape(inp.id)}"]`) : null) ||
          inp.closest('[role="radio"], [role="option"], .option, .choice, .mcq__item, li');

        // Jika labelEl belum ditemukan, tidak terlihat, atau hanya berisi huruf badge 'A'..'F' (sedangkan pill kode berada di sebelahnya),
        // naik ke atas selama elemen belum mencakup input radio lain di soal yang sama
        let p = (labelEl || inp).parentElement;
        for (let d = 0; d < 4 && p; d++) {
          const hasOtherInput = groupInputs.some((other) => other !== inp && p.contains(other));
          if (hasOtherInput) break;
          const pRect = p.getBoundingClientRect();
          if (pRect.height > 125) break;
          const curTxt = labelEl ? this.cleanText(labelEl.innerText || labelEl.textContent || '') : '';
          if (!labelEl || !this.isVisible(labelEl) || curTxt.length <= 2) {
            if (this.isVisible(p)) labelEl = p;
          }
          p = p.parentElement;
        }

        if ((!labelEl || !this.isVisible(labelEl)) && inp.nextElementSibling && this.isVisible(inp.nextElementSibling)) {
          labelEl = inp.nextElementSibling;
        }

        const clickTarget = labelEl && this.isVisible(labelEl) ? labelEl : this.isVisible(inp) ? inp : null;
        if (!clickTarget) continue;

        const optId = this.tagElement(clickTarget, 'mcq-opt');
        inp.setAttribute('data-lms-auto-input-for', optId);
        markOptionProcessed(clickTarget);
        optDomElements.push(clickTarget);

        const rawText = this.cleanText(
          (labelEl ? labelEl.innerText || labelEl.textContent : '') ||
            inp.getAttribute('aria-label') ||
            inp.value ||
            ''
        );
        const cleanOptText = rawText.replace(/^(?:\(?[A-Fa-f]\)?[\.\):]?|[ⒶⒷⒸⒹⒺⒻ])\s+/, '').trim() || rawText;

        resolvedOptions.push({
          id: optId,
          text: cleanOptText,
          isSelected: Boolean(inp.checked),
          isCorrect:
            inp.getAttribute('data-correct') ||
            (labelEl && labelEl.getAttribute('data-correct')) ||
            null
        });
      }

      if (resolvedOptions.length < 2) continue;

      const anchorEl = optDomElements[0] || firstInput;
      const questionId = this.tagQuestionElement(anchorEl, `mcq-${qIndex++}`);
      const isCompleted =
        anchorEl.getAttribute('data-lms-completed') === 'true' ||
        resolvedOptions.some((o) => o.isSelected);

      rawMcqs.push({
        questionId,
        anchorEl,
        containerEl: questionContainer || anchorEl,
        optDomElements,
        inputType: firstInput.type === 'checkbox' ? 'checkbox' : 'radio',
        options: resolvedOptions,
        isCompleted
      });
    }

    // B. Komponen Pilihan Ganda Kustom Eksplisit (role="radiogroup" / kartu opsi dengan class standar / Articulate Rise Knowledge Check)
    const rawCustomOptions = this.queryAllDeep(
      '[role="radio"], [role="option"], .quiz-option, .option-card, .choice-item, .mcq__item, .quiz-card__option, .quiz-multiple-choice-option, .quiz-multiple-response-option, .block-knowledge__option, [data-option], [data-choice]'
    ).filter((el) => {
      if (
        !this.isVisible(el) ||
        this.isInsideSidebarOrHeader(el) ||
        this.isInsideModuleListIndex(el) ||
        isElementInProcessedMCQ(el)
      ) {
        return false;
      }
      if (simContainers.some((sc) => sc === el || sc.contains(el))) return false;
      if (el.querySelector('input[type="radio"], input[type="checkbox"]')) return false;
      const t = this.cleanText(el.innerText || el.textContent || '');
      return t.length > 0 && !this.isSubmitOrNavButtonText(t) && !this.isActionPromptElement(el, customSelectors);
    });

    const outerCustomOptions = rawCustomOptions.filter(
      (el) => !rawCustomOptions.some((other) => other !== el && other.contains(el))
    );

    const customOptionGroups = this.splitOptionElementsIntoQuestionGroups(outerCustomOptions);
    for (const optionEls of customOptionGroups) {
      if (optionEls.length < 2) continue;
      optionEls.forEach(markOptionProcessed);

      const anchorEl = optionEls[0];
      const questionId = this.tagQuestionElement(anchorEl, `mcq-custom-${qIndex++}`);

      const options = optionEls.map((optEl) => {
        // Jika optEl hanya berisi huruf A..F dan memiliki wrapper baris dengan kode di sebelahnya, ambil teks barisnya
        let rowEl = optEl;
        let p = optEl.parentElement;
        for (let d = 0; d < 2 && p; d++) {
          const touchesOther = optionEls.some((other) => other !== optEl && p.contains(other));
          if (touchesOther) break;
          if (this.isVisible(p) && p.getBoundingClientRect().height <= 120) rowEl = p;
          p = p.parentElement;
        }
        const optId = this.tagElement(optEl, 'mcq-copt');
        const rowId = this.tagElement(rowEl, 'mcq-crow');
        if (rowEl !== optEl) markOptionProcessed(rowEl);

        const rawTxt = this.cleanText(rowEl.innerText || rowEl.textContent || optEl.innerText || '');
        const cleanTxt = rawTxt.replace(/^(?:\(?[A-Fa-f]\)?[\.\):]?|[ⒶⒷⒸⒹⒺⒻ])\s+/, '').trim() || rawTxt;

        return {
          id: optId,
          rowId,
          text: cleanTxt,
          isSelected: this.isOptionElementSelected(optEl) || this.isOptionElementSelected(rowEl),
          isCorrect: optEl.getAttribute('data-correct') || rowEl.getAttribute('data-correct') || null
        };
      });

      const isCompleted = anchorEl.getAttribute('data-lms-completed') === 'true';

      rawMcqs.push({
        questionId,
        anchorEl,
        containerEl: anchorEl.parentElement || anchorEl,
        optDomElements: optionEls,
        inputType: 'radio',
        options,
        isCompleted
      });
    }

    // C-1. Deteksi Pilihan Ganda Berlabel Huruf (A, B, C, D / Ⓐ, Ⓑ, Ⓒ, Ⓓ) seperti pada Cisco NetAcad Assessment
    // Menggunakan pengelompokan sekuensial vertikal (A -> B -> C -> D) sehingga tetap akurat meskipun 9 soal berada di dalam 1 kontainer yang sama!
    const allVisibleEls = this.queryAllDeep('span, div, button, li, label, a, p, code, svg, i, b, strong').filter(
      (el) =>
        this.isVisible(el) &&
        !this.isInsideSidebarOrHeader(el) &&
        !isElementInProcessedMCQ(el) &&
        !simContainers.some((sc) => sc === el || sc.contains(el))
    );

    const badgeItems = [];
    for (const el of allVisibleEls) {
      const letter = this.getBadgeLetterFromElement(el);
      if (letter) {
        if (!badgeItems.some((b) => b.el.contains(el) || el.contains(b.el))) {
          badgeItems.push({ el, letter, rect: el.getBoundingClientRect() });
        }
      }
    }

    // Urutkan badge dari atas ke bawah
    badgeItems.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

    const usedBadges = new Set();
    const expectedLetters = ['A', 'B', 'C', 'D', 'E', 'F'];

    for (let i = 0; i < badgeItems.length; i++) {
      const badgeA = badgeItems[i];
      if (badgeA.letter !== 'A' || usedBadges.has(badgeA.el)) continue;

      // Kumpulkan badge B, C, D, E, F secara berurutan di bawah badge A ini (berhenti jika bertemu badge 'A' milik soal berikutnya!)
      const orderedBadges = [badgeA];
      for (let j = i + 1; j < badgeItems.length; j++) {
        const cand = badgeItems[j];
        if (usedBadges.has(cand.el)) continue;
        const prevBadge = orderedBadges[orderedBadges.length - 1];

        // Jika bertemu huruf 'A' baru di bawahnya dan sudah punya minimal A & B, hentikan untuk soal ini
        if (cand.letter === 'A' && cand.rect.top > badgeA.rect.top + 12) {
          break;
        }

        const nextExpected = expectedLetters[orderedBadges.length];
        if (!nextExpected) break;

        // Pastikan posisi vertikal masuk akal (di bawah atau sejajar dengan badge sebelumnya dalam soal yang sama)
        const vDist = cand.rect.top - prevBadge.rect.bottom;
        if (cand.letter === nextExpected && cand.rect.top >= prevBadge.rect.top - 10 && vDist <= 240) {
          orderedBadges.push(cand);
        }
      }

      if (orderedBadges.length < 2) continue;

      orderedBadges.forEach((b) => usedBadges.add(b.el));
      const allBadgeEls = badgeItems.map((b) => b.el);

      // Cari ancestor bersama terdekat untuk grup opsi soal ini
      let groupBox = badgeA.el.parentElement;
      let curr = badgeA.el.parentElement;
      for (let d = 0; d < 6 && curr; d++) {
        if (curr.tagName === 'BODY' || curr.tagName === 'HTML') break;
        if (orderedBadges.every((b) => curr.contains(b.el))) {
          groupBox = curr;
          break;
        }
        curr = curr.parentElement;
      }

      const resolvedOpts = [];
      const optionDomEls = [];

      for (const bItem of orderedBadges) {
        const bEl = bItem.el;
        // Naik ke atas dari bEl selama belum menyentuh badge huruf lainnya dan tinggi baris masih wajar (<= 125px)
        let rowEl = bEl;
        let p = bEl.parentElement;
        for (let d = 0; d < 4 && p && p !== groupBox; d++) {
          const touchesOtherBadge = allBadgeEls.some((other) => other !== bEl && p.contains(other));
          if (touchesOtherBadge) break;
          const pRect = p.getBoundingClientRect();
          if (pRect.height > 125) break;
          if (this.isVisible(p)) {
            rowEl = p;
          }
          p = p.parentElement;
        }

        let pillEl = null;
        let optText = '';

        if (rowEl !== bEl) {
          // Cari elemen pill / kotak kode (`pre`, `code`, `div`, `span`, `button`, `p`) di sebelah badge di dalam rowEl
          const childCandidates = Array.from(
            rowEl.querySelectorAll('pre, code, div, span, button, p, label')
          ).filter(
            (c) =>
              c !== bEl &&
              !bEl.contains(c) &&
              !c.contains(bEl) &&
              this.isVisible(c) &&
              this.cleanText(c.innerText || c.textContent || '').length > 0
          );
          const outerChildPills = childCandidates.filter(
            (c) => !childCandidates.some((other) => other !== c && other.contains(c))
          );
          // Pilih kandidat terluar dengan teks terpanjang (agar kotak `<pre>df.query(...)</pre>` terpilih, BUKAN sub-span token `df`)
          outerChildPills.sort(
            (a, b) =>
              this.cleanText(b.innerText || b.textContent || '').length -
              this.cleanText(a.innerText || a.textContent || '').length
          );
          pillEl = outerChildPills[0] || rowEl;
          const pillTxt = this.cleanText(pillEl.innerText || pillEl.textContent || '');
          const rowTxt = this.cleanText(rowEl.innerText || rowEl.textContent || '')
            .replace(/^(?:\(?[A-Fa-f]\)?[\.\):]?|[ⒶⒷⒸⒹⒺⒻ])\s+/, '')
            .trim();
          optText = rowTxt.length >= pillTxt.length ? rowTxt : pillTxt;
        } else if (groupBox) {
          // Struktur Grid / Flex datar: cari elemen di sebelah kanan bEl pada baris horizontal yang sama
          const bCenterY = bItem.rect.top + bItem.rect.height / 2;
          const rowSiblings = Array.from(
            groupBox.querySelectorAll('pre, code, div, span, button, p, label')
          ).filter((s) => {
            if (s === bEl || bEl.contains(s) || s.contains(bEl) || !this.isVisible(s)) return false;
            if (allBadgeEls.some((ob) => ob === s || s.contains(ob))) return false;
            const sRect = s.getBoundingClientRect();
            if (sRect.height > 120 || sRect.width < 20) return false;
            const sCenterY = sRect.top + sRect.height / 2;
            return Math.abs(sCenterY - bCenterY) <= 32 && sRect.left >= bItem.rect.left + 4;
          });
          const outerSibs = rowSiblings.filter(
            (s) => !rowSiblings.some((other) => other !== s && other.contains(s))
          );
          outerSibs.sort(
            (a, b) =>
              this.cleanText(b.innerText || b.textContent || '').length -
              this.cleanText(a.innerText || a.textContent || '').length
          );
          pillEl = outerSibs[0] || bEl;
          optText = this.cleanText(pillEl.innerText || pillEl.textContent || '');
        }

        optText = optText.replace(/^(?:\(?[A-Fa-f]\)?[\.\):]?|[ⒶⒷⒸⒹⒺⒻ])\s+/, '').trim() || optText;
        if (!optText) continue;

        const targetEl = pillEl || rowEl;
        const optId = this.tagElement(targetEl, 'mcq-lopt');
        const badgeId = this.tagElement(bEl, 'mcq-lbadge');
        const rowId = this.tagElement(rowEl, 'mcq-lrow');

        markOptionProcessed(targetEl);
        markOptionProcessed(rowEl);
        markOptionProcessed(bEl);
        optionDomEls.push(rowEl);
        if (pillEl && pillEl !== rowEl) optionDomEls.push(pillEl);

        resolvedOpts.push({
          id: optId,
          badgeId,
          rowId,
          text: optText,
          isSelected:
            this.isOptionElementSelected(rowEl) ||
            this.isOptionElementSelected(pillEl) ||
            this.isOptionElementSelected(bEl),
          isCorrect:
            rowEl.getAttribute('data-correct') ||
            (pillEl && pillEl.getAttribute('data-correct')) ||
            null
        });
      }

      if (resolvedOpts.length >= 2) {
        const anchorEl = optionDomEls[0] || orderedBadges[0].el;
        const questionId = this.tagQuestionElement(anchorEl, `mcq-letter-${qIndex++}`);
        const isCompleted = anchorEl.getAttribute('data-lms-completed') === 'true';

        rawMcqs.push({
          questionId,
          anchorEl,
          containerEl: groupBox || anchorEl,
          optDomElements: optionDomEls,
          inputType: 'radio',
          options: resolvedOpts,
          isCompleted
        });
      }
    }

    // C-2a. Deteksi Langsung Tumpukan Baris Program / Pill Kode Gelap (seperti `df.query('count == 16')`)
    // Menjamin opsi berbentuk baris program tetap terdeteksi 100% meskipun lencana A/B/C/D berupa ikon SVG tanpa teks atau CSS counter!
    const rawDarkCodePills = this.queryAllDeep('pre, code, div, span, button, li, label').filter(
      (el) =>
        this.isDarkCodePillElement(el) &&
        !this.isInsideSidebarOrHeader(el) &&
        !isElementInProcessedMCQ(el) &&
        !simContainers.some((sc) => sc === el || sc.contains(el) || el.contains(sc))
    );

    const outerDarkCodePills = rawDarkCodePills.filter(
      (el) => !rawDarkCodePills.some((other) => other !== el && other.contains(el))
    );
    outerDarkCodePills.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

    // Kelompokkan pill kode gelap yang tersusun vertikal sejajar (2..6 opsi per soal)
    const darkPillGroups = [];
    for (let i = 0; i < outerDarkCodePills.length; i++) {
      const pill = outerDarkCodePills[i];
      if (isElementInProcessedMCQ(pill)) continue;
      const group = [pill];
      for (let j = i + 1; j < outerDarkCodePills.length; j++) {
        const nextPill = outerDarkCodePills[j];
        if (isElementInProcessedMCQ(nextPill)) continue;
        const prevRect = group[group.length - 1].getBoundingClientRect();
        const nextRect = nextPill.getBoundingClientRect();
        const gapY = nextRect.top - prevRect.bottom;
        if (Math.abs(nextRect.left - prevRect.left) <= 32 && gapY >= -4 && gapY <= 45) {
          group.push(nextPill);
          if (group.length >= 6) break;
        } else if (gapY > 45) {
          break;
        }
      }
      if (group.length >= 2) {
        darkPillGroups.push(group);
        i += group.length - 1;
      }
    }

    for (const pillGroup of darkPillGroups) {
      const optionDomEls = [];
      const options = pillGroup.map((pillEl) => {
        // Cari rowEl yang membungkus lencana (A/B/C/D) di kiri dan pill kode di kanan
        let rowEl = pillEl;
        let p = pillEl.parentElement;
        for (let d = 0; d < 3 && p; d++) {
          const touchesOtherPill = pillGroup.some((other) => other !== pillEl && p.contains(other));
          if (touchesOtherPill) break;
          const pRect = p.getBoundingClientRect();
          if (pRect.height > 120) break;
          if (this.isVisible(p)) rowEl = p;
          p = p.parentElement;
        }

        // Cari elemen lencana/ikon di sebelah kiri pillEl di dalam rowEl (jika ada)
        let badgeEl = null;
        if (rowEl !== pillEl) {
          const pillRect = pillEl.getBoundingClientRect();
          badgeEl =
            Array.from(rowEl.children).find(
              (ch) =>
                ch !== pillEl &&
                !ch.contains(pillEl) &&
                this.isVisible(ch) &&
                ch.getBoundingClientRect().left < pillRect.left
            ) || null;
        }

        const optId = this.tagElement(pillEl, 'mcq-codeopt');
        const rowId = this.tagElement(rowEl, 'mcq-coderow');
        const badgeId = badgeEl ? this.tagElement(badgeEl, 'mcq-codebadge') : null;

        markOptionProcessed(pillEl);
        markOptionProcessed(rowEl);
        if (badgeEl) markOptionProcessed(badgeEl);
        optionDomEls.push(rowEl);
        if (pillEl !== rowEl) optionDomEls.push(pillEl);

        const rawTxt = this.cleanText(pillEl.innerText || pillEl.textContent || rowEl.innerText || '');
        const cleanTxt = rawTxt.replace(/^(?:\(?[A-Fa-f]\)?[\.\):]?|[ⒶⒷⒸⒹⒺⒻ])\s+/, '').trim() || rawTxt;

        return {
          id: optId,
          rowId,
          badgeId,
          text: cleanTxt,
          isSelected: this.isOptionElementSelected(rowEl) || this.isOptionElementSelected(pillEl),
          isCorrect: rowEl.getAttribute('data-correct') || pillEl.getAttribute('data-correct') || null
        };
      });

      const anchorEl = optionDomEls[0] || pillGroup[0];
      const questionId = this.tagQuestionElement(anchorEl, `mcq-code-${qIndex++}`);
      const isCompleted = anchorEl.getAttribute('data-lms-completed') === 'true';

      rawMcqs.push({
        questionId,
        anchorEl,
        containerEl: anchorEl.parentElement || anchorEl,
        optDomElements: optionDomEls,
        inputType: 'radio',
        options,
        isCompleted
      });
    }

    // C-2b. Fallback Umum: Deteksi rentetan berurutan 3..6 baris opsi vertikal yang sejajar di dalam kontainer mana pun
    // (Tetap bekerja meskipun di dalam kontainer yang sama terdapat `<p>` teks soal atau `<table>` DataFrame!)
    const candidateGroups = this.queryAllDeep('div, ul, ol, section, fieldset, article').filter(
      (box) =>
        this.isVisible(box) &&
        !this.isInsideSidebarOrHeader(box) &&
        !this.isInsideModuleListIndex(box) &&
        !simContainers.some((sc) => sc === box || sc.contains(box) || box.contains(sc))
    );

    for (const box of candidateGroups) {
      if (box.querySelector('input[type="radio"], input[type="checkbox"], textarea, select')) continue;

      const candidateRows = Array.from(box.children).filter((c) => {
        if (!this.isVisible(c) || isElementInProcessedMCQ(c) || this.isInsideModuleListIndex(c)) return false;
        const tag = c.tagName.toUpperCase();
        if (['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'BR', 'TABLE', 'THEAD', 'TBODY', 'TR'].includes(tag)) {
          return false;
        }
        if (c.querySelector && c.querySelector('table')) return false;
        // PENTING: Tolak jika baris adalah tautan navigasi halaman/modul (`<a href="/courses/...">`) seperti di daftar modul Canvas!
        const navLinks = c.tagName === 'A' ? [c] : Array.from(c.querySelectorAll ? c.querySelectorAll('a[href]') : []);
        const hasPageNavLink = navLinks.some((a) => {
          const h = (a.getAttribute('href') || '').trim();
          return h.length > 1 && !h.startsWith('#') && !/^javascript:/i.test(h);
        });
        if (hasPageNavLink) return false;

        const r = c.getBoundingClientRect();
        if (r.height < 20 || r.height > 115 || r.width < 85) return false;
        const txt = this.cleanText(c.innerText || c.textContent || '');
        if (!txt || txt.length > 260 || this.isSubmitOrNavButtonText(txt) || this.isActionPromptElement(c, customSelectors)) {
          return false;
        }
        return true;
      });

      if (candidateRows.length < 3) continue;

      // Cari sub-rentetan (contiguous runs) 3..6 baris yang sejajar secara vertikal
      let i = 0;
      while (i < candidateRows.length) {
        const firstRow = candidateRows[i];
        if (isElementInProcessedMCQ(firstRow)) {
          i++;
          continue;
        }
        const firstRect = firstRow.getBoundingClientRect();
        const run = [firstRow];

        for (let j = i + 1; j < candidateRows.length; j++) {
          const nextRow = candidateRows[j];
          if (isElementInProcessedMCQ(nextRow)) break;
          const prevRect = run[run.length - 1].getBoundingClientRect();
          const r = nextRow.getBoundingClientRect();
          const gapY = r.top - prevRect.bottom;

          if (
            Math.abs(r.left - firstRect.left) <= 24 &&
            Math.abs(r.height - firstRect.height) <= 36 &&
            gapY >= -4 &&
            gapY <= 42
          ) {
            run.push(nextRow);
            if (run.length >= 6) break;
          } else {
            break;
          }
        }

        if (run.length >= 3 && run.length <= 6) {
          const allInteractiveOptions = run.every((row) => {
            const win = row.ownerDocument?.defaultView || window;
            const style = win.getComputedStyle(row);
            if (
              style.cursor === 'pointer' ||
              row.tagName === 'BUTTON' ||
              row.getAttribute('role') === 'button' ||
              row.getAttribute('role') === 'radio' ||
              this.hasVisualPillStyle(row) ||
              this.isDarkCodePillElement(row)
            ) {
              return true;
            }
            return Array.from(row.querySelectorAll('pre, code, div, span, button')).some((ch) => {
              if (!this.isVisible(ch)) return false;
              const chStyle = win.getComputedStyle(ch);
              return (
                chStyle.cursor === 'pointer' ||
                this.hasVisualPillStyle(ch) ||
                this.isDarkCodePillElement(ch)
              );
            });
          });

          if (allInteractiveOptions) {
            run.forEach(markOptionProcessed);
            const anchorEl = run[0];
            const questionId = this.tagQuestionElement(anchorEl, `mcq-stack-${qIndex++}`);

            const options = run.map((row) => {
              const pillCandidates = Array.from(row.querySelectorAll('pre, code, div, span, button')).filter(
                (ch) =>
                  this.isVisible(ch) &&
                  (this.hasVisualPillStyle(ch) || this.isDarkCodePillElement(ch)) &&
                  this.cleanText(ch.innerText || ch.textContent || '').length > 1
              );
              pillCandidates.sort(
                (a, b) =>
                  this.cleanText(b.innerText || b.textContent || '').length -
                  this.cleanText(a.innerText || a.textContent || '').length
              );
              const pillChild = pillCandidates[0] || null;
              const clickEl = pillChild || row;
              const optId = this.tagElement(clickEl, 'mcq-sopt');
              const rowId = this.tagElement(row, 'mcq-srow');
              const rawTxt = this.cleanText(row.innerText || row.textContent || '');
              const cleanTxt = rawTxt.replace(/^(?:\(?[A-Fa-f]\)?[\.\):]?|[ⒶⒷⒸⒹⒺⒻ])\s+/, '').trim() || rawTxt;

              return {
                id: optId,
                rowId,
                text: cleanTxt,
                isSelected:
                  this.isOptionElementSelected(row) ||
                  (pillChild && this.isOptionElementSelected(pillChild)),
                isCorrect: row.getAttribute('data-correct') || null
              };
            });

            const isCompleted = anchorEl.getAttribute('data-lms-completed') === 'true';

            rawMcqs.push({
              questionId,
              anchorEl,
              containerEl: box,
              optDomElements: run,
              inputType: 'radio',
              options,
              isCompleted
            });

            i += run.length;
            continue;
          }
        }
        i++;
      }
    }

    // D. Dropdown `<select>` di dalam Pertanyaan Kuis / Survey (seperti pada Canvas Pre-Course Survey / Matching Question)
    const quizSelects = this.queryAllDeep(
      '.display_question select, .question select, .quiz-question select, [data-question] select, .assessment-item select'
    ).filter(
      (sel) =>
        this.isVisible(sel) &&
        !sel.disabled &&
        !this.isInsideSidebarOrHeader(sel) &&
        !this.isInsideModuleListIndex(sel) &&
        !isElementInProcessedMCQ(sel)
    );

    for (const selEl of quizSelects) {
      const validOptEls = Array.from(selEl.options || []).filter((opt) => {
        const val = (opt.value || '').trim();
        const txt = this.cleanText(opt.text || opt.innerText || '');
        if (!txt || opt.disabled) return false;
        if (!val || /^(\[\s*select\s*\]|--|choose|pilih)/i.test(txt)) return false;
        return true;
      });
      if (validOptEls.length < 2) continue;

      markOptionProcessed(selEl);
      const questionId = this.tagQuestionElement(selEl, `mcq-select-${qIndex++}`);
      const qBox =
        selEl.closest('.display_question, .question, .quiz-question, [data-question], tr, li, div') ||
        selEl.parentElement;

      const resolvedOpts = validOptEls.map((optEl, oIdx) => {
        const optId = `${questionId}-opt-${oIdx}`;
        optEl.setAttribute('data-lms-auto-id', optId);
        return {
          id: optId,
          selectValue: optEl.value,
          text: this.cleanText(optEl.text || optEl.innerText || ''),
          isSelected: selEl.value === optEl.value && selEl.getAttribute('data-lms-completed') === 'true',
          isCorrect: null
        };
      });

      rawMcqs.push({
        questionId,
        anchorEl: selEl,
        containerEl: qBox,
        optDomElements: [selEl],
        inputType: 'select',
        options: resolvedOpts,
        isCompleted: selEl.getAttribute('data-lms-completed') === 'true'
      });
    }

    // Urutkan seluruh soal pilihan ganda dari atas ke bawah berdasarkan posisi vertikal di halaman
    rawMcqs.sort((a, b) => {
      const rA = a.anchorEl ? a.anchorEl.getBoundingClientRect().top : 0;
      const rB = b.anchorEl ? b.anchorEl.getBoundingClientRect().top : 0;
      return rA - rB;
    });

    // Ekstrak teks pertanyaan & tabel DataFrame (`df:` vs `result df:`) secara spesifik untuk masing-masing soal
    // dengan membatasi area vertikal di antara batas bawah opsi soal sebelumnya dan batas atas opsi soal saat ini!
    const mcqs = rawMcqs.map((item, idx) => {
      let prevBottomY = null;
      if (idx > 0) {
        const prevEls = rawMcqs[idx - 1].optDomElements || [];
        const prevBottoms = prevEls
          .filter(Boolean)
          .map((el) => el.getBoundingClientRect().bottom)
          .filter((val) => Number.isFinite(val));
        if (prevBottoms.length > 0) {
          prevBottomY = Math.max(...prevBottoms);
        }
      }

      const { questionText, tableData } = this.extractQuestionPrompt(
        item.containerEl,
        item.optDomElements,
        prevBottomY,
        true
      );

      return {
        questionId: item.questionId,
        questionText,
        tableData,
        inputType: item.inputType,
        options: item.options,
        isCompleted: item.isCompleted
      };
    });

    return mcqs;
  },

  /**
   * Ekstrak konteks pertanyaan pilihan ganda beserta ringkasan & baris tabel DataFrame (`df:` vs `result df:`) di atasnya.
   * Jika berada di halaman multi-soal (9 soal dalam 1 halaman), batasi pengambilan teks & tabel hanya pada pita vertikal
   * di antara `prevQuestionBottomY` dan bagian atas opsi soal ini!
   */
  extractQuestionPrompt(container, optionElements = [], prevQuestionBottomY = null, returnObject = false) {
    if (!container) {
      return returnObject ? { questionText: 'Pertanyaan Kuis', tableData: null } : 'Pertanyaan Kuis';
    }

    // Hitung batas vertikal opsi soal ini
    const optRects = (optionElements || [])
      .filter((el) => el && typeof el.getBoundingClientRect === 'function')
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);

    const firstOptTop = optRects.length > 0 ? Math.min(...optRects.map((r) => r.top)) : null;
    const minY =
      prevQuestionBottomY !== null && Number.isFinite(prevQuestionBottomY)
        ? prevQuestionBottomY - 6
        : firstOptTop !== null
        ? firstOptTop - 650
        : null;
    const maxY = firstOptTop !== null ? firstOptTop + 18 : null;

    // Naik 1..4 level ke atas agar mencakup teks soal & tabel di atas daftar opsi
    let scopeEl = container;
    let curr = container.parentElement || (container.getRootNode && container.getRootNode().host) || null;
    for (let d = 0; d < 4 && curr && curr.nodeType === 1; d++) {
      const tag = (curr.tagName || '').toUpperCase();
      if (tag === 'BODY' || tag === 'HTML') break;
      const txtLen = this.cleanText(curr.innerText || curr.textContent || '').length;
      if (txtLen > 0 && txtLen <= 12000) {
        scopeEl = curr;
        if (
          firstOptTop !== null &&
          curr.getBoundingClientRect().top <= (minY !== null ? Math.max(minY, firstOptTop - 320) : firstOptTop - 120)
        ) {
          break;
        }
      }
      curr = curr.parentElement || (curr.getRootNode && curr.getRootNode().host) || null;
    }

    const optIds = new Set(
      (optionElements || [])
        .map((el) => (el && typeof el.getAttribute === 'function' ? el.getAttribute('data-lms-auto-id') : null))
        .filter(Boolean)
    );

    // 1. Ekstrak tabel DataFrame (`df:` dan `result df:`) yang berada tepat di atas opsi soal ini (di dalam rentang [minY, maxY])
    let tableSummaryText = '';
    let tableData = null;
    const allTables = this.queryAllDeep('table', scopeEl).filter((t) => {
      if (!this.isVisible(t)) return false;
      if (firstOptTop !== null) {
        const tRect = t.getBoundingClientRect();
        if (tRect.top > maxY || (minY !== null && tRect.bottom < minY)) return false;
      }
      return true;
    });

    if (allTables.length > 0) {
      const parsedTables = [];
      allTables.forEach((tbl, tIdx) => {
        const rows = Array.from(tbl.querySelectorAll('tr'));
        if (rows.length < 2) return;
        const headerCells = Array.from(rows[0].querySelectorAll('th, td')).map((c) =>
          this.cleanText(c.innerText || c.textContent || '')
        );
        const colMap = {};
        const colNames = [];

        headerCells.forEach((h, cIdx) => {
          if (h && !/^\d+$/.test(h)) {
            colNames.push({ name: h, idx: cIdx });
            colMap[h] = [];
          }
        });

        const rowObjects = [];
        for (let r = 1; r < Math.min(rows.length, 15); r++) {
          const cells = Array.from(rows[r].querySelectorAll('th, td')).map((c) =>
            this.cleanText(c.innerText || c.textContent || '')
          );
          const offset = cells.length === headerCells.length + 1 ? 1 : 0;
          const rowObj = {};
          let hasAnyVal = false;
          for (const col of colNames) {
            const val = cells[col.idx + offset] ?? cells[col.idx];
            if (val !== undefined && val !== '') {
              colMap[col.name].push(val);
              rowObj[col.name] = val;
              hasAnyVal = true;
            }
          }
          if (hasAnyVal) rowObjects.push(rowObj);
        }

        const colDesc = colNames
          .map((c) => `${c.name}=[${(colMap[c.name] || []).slice(0, 4).join(', ')}]`)
          .join(', ');
        if (colDesc) {
          parsedTables.push({
            index: tIdx + 1,
            colNames: colNames.map((c) => c.name),
            colMap,
            rowObjects,
            desc: `[Table ${tIdx + 1}: ${colDesc}]`
          });
        }
      });

      if (parsedTables.length > 0) {
        tableData = {
          dfRows: parsedTables[0].rowObjects || [],
          colNames: parsedTables[0].colNames || [],
          resultRows: parsedTables.length >= 2 ? parsedTables[1].rowObjects || [] : [],
          resultColNames: parsedTables.length >= 2 ? parsedTables[1].colNames || [] : []
        };
      }

      const summaryParts = parsedTables.map((pt) => pt.desc);
      if (parsedTables.length >= 2) {
        const t1 = parsedTables[0].colMap;
        const t2 = parsedTables[1].colMap;
        for (const colName of Object.keys(t1)) {
          if (t2[colName]) {
            const v1 = t1[colName].join('|');
            const v2 = t2[colName].join('|');
            if (v1 !== v2) {
              summaryParts.push(
                `[ChangedColumn: ${colName} (${t1[colName][0] || ''} -> ${t2[colName][0] || ''})]`
              );
            } else {
              summaryParts.push(`[UnchangedColumn: ${colName}]`);
            }
          }
        }
      }
      tableSummaryText = summaryParts.join(' ');
    }

    // 2. Ekstrak teks pertanyaan khusus pada rentang vertikal soal ini `[minY, maxY]`
    let basePrompt = '';
    if (firstOptTop !== null && minY !== null && maxY !== null) {
      const textNodes = Array.from(
        scopeEl.querySelectorAll('p, h1, h2, h3, h4, h5, .question-text, .prompt, li, div, span')
      ).filter((el) => {
        if (!this.isVisible(el)) return false;
        if (el.closest('table')) return false;
        if ((optionElements || []).some((opt) => opt === el || opt.contains(el) || el.contains(opt))) {
          return false;
        }
        const r = el.getBoundingClientRect();
        if (r.bottom < minY - 4 || r.top > maxY) return false;
        const t = this.cleanText(el.innerText || el.textContent || '');
        return t.length >= 4 && !/^(df|result\s*df)\s*:?$/i.test(t);
      });

      const outerTextNodes = textNodes.filter(
        (el) => !textNodes.some((other) => other !== el && other.contains(el))
      );
      if (outerTextNodes.length > 0) {
        basePrompt = outerTextNodes
          .map((el) => this.cleanText(el.innerText || el.textContent || ''))
          .join(' ')
          .slice(0, 900);
      }
    }

    if (!basePrompt) {
      const clone = scopeEl.cloneNode(true);
      clone
        .querySelectorAll('label, input, [role="radio"], [role="option"], .quiz-option, .option-card, table')
        .forEach((n) => n.remove());
      if (optIds.size > 0) {
        clone.querySelectorAll('[data-lms-auto-id]').forEach((n) => {
          if (optIds.has(n.getAttribute('data-lms-auto-id'))) {
            n.remove();
          }
        });
      }
      basePrompt = this.cleanText(clone.innerText || clone.textContent || '').slice(0, 900) || 'Pertanyaan Pilihan Ganda';
    }

    const fullPrompt = tableSummaryText ? `${basePrompt} ${tableSummaryText}` : basePrompt;
    return returnObject ? { questionText: fullPrompt, tableData } : fullPrompt;
  },

  /**
   * 3. Pindai Soal Esai & Isian Teks (Textarea, Input Teks, dan Rich-Text Editor)
   */
  scanEssays(customSelectors = {}, simulations = []) {
    const essays = [];
    const candidates = new Set();
    const simContainers = simulations
      .map((s) => this.getElementById(s.taskId))
      .filter(Boolean);

    // Textarea standar
    this.queryAllDeep('textarea').forEach((el) => {
      if (this.isVisible(el) && !el.disabled && !el.readOnly) {
        candidates.add(el);
      }
    });

    // Rich text editors (ContentEditable, Quill, CKEditor, TinyMCE inline)
    this.queryAllDeep('[contenteditable="true"], .ql-editor, .ck-editor__editable').forEach((el) => {
      if (this.isVisible(el)) {
        candidates.add(el);
      }
    });

    // Input teks yang berada di dalam kontainer soal/tugas (bukan search bar atau navigasi)
    this.queryAllDeep(
      '.question input[type="text"], .quiz-question input[type="text"], .essay-question input[type="text"], [data-question] input[type="text"], .task-card input[type="text"]'
    ).forEach((el) => {
      if (this.isVisible(el) && !el.disabled && !el.readOnly) {
        candidates.add(el);
      }
    });

    if (customSelectors.essayInput) {
      try {
        this.queryAllDeep(customSelectors.essayInput).forEach((el) => {
          if (this.isVisible(el)) candidates.add(el);
        });
      } catch {
        // Abaikan selector kustom tidak valid
      }
    }

    let eIndex = 1;
    for (const el of candidates) {
      if (el.closest('nav, header, footer, #lms-autopilot-hud-host')) continue;
      if (this.isInsideSidebarOrHeader(el)) continue;
      // Jangan pernah menganggap textarea/input internal milik code editor (Monaco, CodeMirror, Ace, Xterm) atau simulasi sebagai soal esai
      if (
        el.closest(
          '.monaco-editor, .CodeMirror, .cm-editor, .ace_editor, .xterm, .terminal, .py-editor-box, .code-editor, .code-box, .code-cell, .notebook-cell, [data-code-editor], [data-simulation]'
        )
      ) {
        continue;
      }
      if (/\b(inputarea|ace_text-input|xterm-helper-textarea|clipboard)\b/i.test(el.className || '')) {
        continue;
      }
      if (el.getAttribute('aria-hidden') === 'true') continue;

      const rect = el.getBoundingClientRect();
      // Abaikan elemen input/textarea yang terlalu kecil (seperti hidden 1x1px helper pada editor kode)
      if (rect.width < 80 || rect.height < 22) continue;

      // Jangan anggap input di dalam kontainer simulasi sebagai soal esai kecuali berada di dalam kartu pertanyaan tersendiri
      if (
        simContainers.some((sc) => sc.contains(el)) &&
        !el.closest('.essay-question, .question-card, .quiz-question')
      ) {
        continue;
      }

      const essayId = this.tagElement(el, `essay-${eIndex++}`);
      const questionContainer = el.closest(
        '.essay-question, .question-card, .quiz-question, .task-card, .que, .form-group, fieldset, section'
      );

      let questionText = '';
      const doc = el.ownerDocument || document;
      if (el.id) {
        const lbl = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) questionText = this.cleanText(lbl.innerText);
      }

      if (!questionText && questionContainer) {
        const promptEl = questionContainer.querySelector(
          'label, .question-text, .qtext, .essay-prompt, .question-title, h3, h4, p'
        );
        if (promptEl && !promptEl.contains(el)) {
          questionText = this.cleanText(promptEl.innerText);
        } else {
          questionText = this.cleanText(questionContainer.innerText).slice(0, 500);
        }
      }

      if (!questionText) {
        questionText =
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          'Jelaskan kesimpulan dari materi pada modul ini.';
      }

      const currentValue =
        el.isContentEditable || (el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT')
          ? this.cleanText(el.innerText)
          : this.cleanText(el.value);

      essays.push({
        essayId,
        questionText,
        placeholder: el.getAttribute('placeholder') || '',
        isContentEditable: Boolean(el.isContentEditable),
        currentValue,
        isFilled: el.getAttribute('data-lms-completed') === 'true' || currentValue.length > 15
      });
    }

    return essays;
  },

  /**
   * 4. Pindai Tombol Submit / Verifikasi Jawaban & Tombol Navigasi Modul Berikutnya (Next)
   *    (Mendukung Halaman Daftar Modul Canvas `/courses/.../modules`, `.module-sequence-footer`, Articulate Rise, maupun Course Outline)
   */
  scanNavigation(customSelectors = {}, simulations = []) {
    // A. Jika saat ini berada di Halaman Daftar Modul (seperti `awsacademy.instructure.com/courses/184279/modules`),
    //    langsung cari item modul pertama yang belum selesai / belum dikunjungi untuk dimasuki!
    //    PENTING: Selalu return di sini agar tidak pernah jatuh ke menu sidebar kiri (Home/Discussions/Grades/Notebook)!
    if (this.isModulesIndexPage()) {
      const modEntry = this.findNextModuleIndexItem();
      const nextId = modEntry ? this.tagElement(modEntry.el, 'nav-mod-entry') : null;
      return {
        submitButtonId: null,
        submitButtonLabel: null,
        submitButtonIds: [],
        nextButtonId: nextId,
        nextButtonLabel: modEntry ? `Masuk Modul: ${modEntry.label}` : null,
        nextButtonHref: modEntry ? modEntry.href || '' : '',
        isCarouselNext: false,
        isOutlineNext: false,
        isModuleIndexEntry: Boolean(modEntry)
      };
    }

    const runBtnIds = new Set();
    simulations.forEach((s) => s.runButtons.forEach((rb) => runBtnIds.add(rb.id)));

    const rawClickables = this.queryAllDeep(
      'button, a, input[type="submit"], input[type="button"], [role="button"], .next-step, [class*="next"], [class*="nav"], [class*="continue"], div, span'
    ).filter((el) => {
      if (!this.isVisible(el) || el.disabled) return false;
      if (this.isInsideSidebarOrHeader(el) || this.isResourceOrExternalLink(el)) return false;
      const tag = el.tagName.toUpperCase();
      if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || el.getAttribute('role') === 'button') {
        return true;
      }
      // Untuk elemen div/span, hanya sertakan jika bergaya tombol pill dan bukan wrapper dari banyak tombol
      const win = el.ownerDocument?.defaultView || window;
      const style = win.getComputedStyle(el);
      return (style.cursor === 'pointer' || this.hasVisualPillStyle(el)) && !this.isTileWrapper(el);
    });

    // Pilih elemen terdalam jika ada wrapper yang membungkus tombol tunggal dengan teks sama
    const clickables = rawClickables.filter(
      (el) =>
        !rawClickables.some(
          (other) =>
            other !== el &&
            el.contains(other) &&
            this.cleanText(other.innerText || '') === this.cleanText(el.innerText || '')
        )
    );

    let submitButtonId = null;
    let submitButtonLabel = null;
    const submitButtonIds = [];
    let nextButtonId = null;
    let nextButtonLabel = null;
    let isCarouselNext = false;

    // Cek selector kustom terlebih dahulu
    if (customSelectors.submitButton) {
      try {
        const customSub = document.querySelector(customSelectors.submitButton);
        if (customSub && this.isVisible(customSub)) {
          submitButtonId = this.tagElement(customSub, 'nav-submit');
          submitButtonLabel = this.cleanText(customSub.innerText || customSub.value || 'Submit');
          submitButtonIds.push({ id: submitButtonId, label: submitButtonLabel });
        }
      } catch {}
    }

    if (customSelectors.nextButton) {
      try {
        const customNext = document.querySelector(customSelectors.nextButton);
        if (customNext && this.isVisible(customNext)) {
          nextButtonId = this.tagElement(customNext, 'nav-next');
          nextButtonLabel = this.cleanText(customNext.innerText || customNext.value || 'Next');
        }
      } catch {}
    }

    // Cek tombol NEXT lokal di dalam kartu soal Articulate Rise Knowledge Check (`.quiz-card__button--next`)
    if (!nextButtonId) {
      const riseQuizNext = this.queryAllDeep(
        '.quiz-card__button--next, button.quiz-card__next, .block-knowledge__button--next'
      ).find((el) => this.isVisible(el) && !el.disabled && el.getAttribute('data-lms-nav-visited') !== 'true');
      if (riseQuizNext) {
        nextButtonId = this.tagElement(riseQuizNext, 'nav-rise-qnext');
        nextButtonLabel = this.cleanText(riseQuizNext.innerText || 'Next Question');
        isCarouselNext = true;
      }
    }

    // Cek tombol `Next ›` sekuensial eksplisit milik Canvas LMS (`.module-sequence-footer-button--next a`)
    if (!nextButtonId) {
      const canvasFooterNext = this.queryAllDeep(
        '.module-sequence-footer-button--next a, a.module-sequence-footer-button--next, [data-testid="next-button"]'
      ).find((el) => this.isVisible(el) && !el.disabled && el.getAttribute('data-lms-nav-visited') !== 'true');
      if (canvasFooterNext) {
        nextButtonId = this.tagElement(canvasFooterNext, 'nav-canvas-next');
        nextButtonLabel = this.cleanText(canvasFooterNext.innerText || canvasFooterNext.getAttribute('aria-label') || 'Next ›');
      }
    }

    const submitRegex =
      /^(?:submit|kirim|check|periksa|verify|verifikasi)$|\b(kirim\s*jawaban|kirim\s*tugas|submit\s*quiz|submit\s*survey|submit\s*answer|submit\s*response|submit\s*assessment|submit|periksa\s*jawaban|cek\s*jawaban|check\s*answer|simpan\s*&\s*kirim|verifikasi\s*jawaban|selesai\s*kuis|finish\s*attempt)\b/i;
    const nextRegex =
      /\b(modul\s*selanjutnya|modul\s*berikutnya|materi\s*selanjutnya|materi\s*berikutnya|halaman\s*berikutnya|selanjutnya|berikutnya|lanjutkan\s*modul|lanjutkan|lanjut|next\s*module|next\s*lesson|next\s*activity|next\s*section|next\s*chapter|next\s*page|next\s*question|next|continue|chapter\s*assessment|module\s*assessment|unit\s*assessment|final\s*assessment|practice\s*assessment|start\s*assessment|take\s*assessment|chapter\s*quiz|module\s*quiz|tandai\s*selesai\s*&\s*lanjut|selesai\s*&\s*lanjut)\b/i;

    for (const el of clickables) {
      const existingId = el.getAttribute('data-lms-auto-id');
      if (existingId && runBtnIds.has(existingId)) continue;
      if (this.isActionPromptElement(el, customSelectors)) continue;

      const text = this.cleanText(
        el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || ''
      );
      if (!text || text.length > 95) continue;

      if (
        el.getAttribute('data-lms-completed') !== 'true' &&
        (el.hasAttribute('data-submit-quiz') || el.id === 'submit_quiz_button' || submitRegex.test(text))
      ) {
        const sId = this.tagElement(el, 'nav-submit');
        submitButtonIds.push({ id: sId, label: text });
        if (!submitButtonId) {
          submitButtonId = sId;
          submitButtonLabel = text;
        }
        continue;
      }

      // Cek apakah tombol ini adalah tombol Next atau tombol transisi bab/sub-modul (seperti "Chapter Assessment >")
      const isChevronNextBtn =
        this.hasVisualPillStyle(el) &&
        /[>›»→➔⟶\u203A\u276F]\s*$/.test(text) &&
        !/[=()]|\b(import|from|def|print|read_csv)\b/.test(text);

      if (
        !nextButtonId &&
        el.getAttribute('data-lms-nav-visited') !== 'true' &&
        (el.hasAttribute('data-next-module') || nextRegex.test(text) || isChevronNextBtn)
      ) {
        nextButtonId = this.tagElement(el, 'nav-next');
        nextButtonLabel = text;
      }
    }

    // Jika tidak ditemukan tombol Next berteks di area konten utama,
    // cek terlebih dahulu apakah ada tombol panah kanan `>` untuk slide/soal berikutnya pada Carousel Assessment!
    if (!nextButtonId) {
      const carouselNext = this.findCarouselNextButton(runBtnIds);
      if (carouselNext) {
        nextButtonId = this.tagElement(carouselNext.el, 'nav-carousel-next');
        nextButtonLabel = carouselNext.label;
        isCarouselNext = true;
      }
    }

    // Jika pengguna sedang berada di tab non-modul pada Canvas LMS (seperti Discussions, Announcements, Grades, Home, Lucid, atau Notebook)
    // yang tidak memiliki tombol Next › (`.module-sequence-footer`), otomatis arahkan ke tab "Modules" agar masuk ke daftar modul!
    if (!nextButtonId && document.querySelector('#section-tabs')) {
      const hrefNow = window.location.href || '';
      const isInsideModuleOrQuiz =
        /\/(?:modules|quizzes)\//i.test(hrefNow) ||
        Boolean(document.querySelector('.module-sequence-footer, #questions'));
      if (!isInsideModuleOrQuiz) {
        const modulesTabLink = document.querySelector(
          '#section-tabs a.modules, #section-tabs a[href$="/modules"], #section-tabs a[href*="/modules"]'
        );
        if (modulesTabLink && this.isVisible(modulesTabLink)) {
          nextButtonId = this.tagElement(modulesTabLink, 'nav-canvas-modules-tab');
          nextButtonLabel = 'Buka Daftar Modul (Modules)';
        }
      }
    }

    // Jika tidak ada tombol Next maupun panah Carousel `>` yang aktif di area konten utama,
    // barulah pindah ke sub-modul berikutnya di Course Outline / Sidebar kiri (misal dari "Assessment" -> "Reflections" pada NetAcad)
    let isOutlineNext = false;
    if (!nextButtonId) {
      const nextOutlineItem = this.findNextOutlineItem();
      if (nextOutlineItem) {
        nextButtonId = this.tagElement(nextOutlineItem.el, 'nav-outline-next');
        nextButtonLabel = nextOutlineItem.label;
        isOutlineNext = true;
      }
    }

    return {
      submitButtonId,
      submitButtonLabel,
      submitButtonIds,
      nextButtonId,
      nextButtonLabel,
      isCarouselNext,
      isOutlineNext,
      isModuleIndexEntry: false
    };
  },

  /**
   * Cari item modul pertama yang belum selesai / belum dikunjungi pada Halaman Daftar Modul Canvas
   * (Contoh: `https://awsacademy.instructure.com/courses/184279/modules`)
   */
  findNextModuleIndexItem() {
    // 1. Kumpulkan semua baris item modul (`li.context_module_item`) yang tidak tersembunyi oleh `display: none`
    const allItemRows = Array.from(
      document.querySelectorAll(
        '#context_modules li.context_module_item, .context_module_items li.context_module_item, li.context_module_item, .context_module_item, [data-module-item-id]'
      )
    );

    const visibleItemRows = allItemRows.filter((li) => {
      const r = li.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });

    // Jika semua modul masih terlipat (collapsed), klik tombol Expand All / pembuka modul terlebih dahulu
    if (visibleItemRows.length === 0) {
      const expandBtn = document.querySelector(
        '.collapse_module_link[aria-expanded="false"], #expand_collapse_all'
      );
      if (expandBtn && expandBtn.getBoundingClientRect().width > 0) {
        return {
          el: expandBtn,
          label: this.cleanText(expandBtn.innerText || 'Expand Modules'),
          href: ''
        };
      }
    }

    const rowsToScan = visibleItemRows.length > 0 ? visibleItemRows : allItemRows;
    const candidates = [];

    for (const li of rowsToScan) {
      if (
        li.classList.contains('context_module_item_locked') ||
        li.classList.contains('context_module_sub_header') ||
        li.classList.contains('ig-sub-header') ||
        li.querySelector('.icon-lock, .locked_title')
      ) {
        continue;
      }

      // PENTING: Di Canvas LMS, di dalam `<div class="ig-row">` terdapat `<a class="for-nvda" href="...">` (tersembunyi untuk screen reader)
      // yang posisinya lebih dulu di DOM dibanding `<a class="ig-title title item_link">`.
      // Jangan gunakan `li.querySelector(...)` gabungan karena akan menangkap `a.for-nvda` yang tidak terlihat!
      const allLinks = Array.from(li.querySelectorAll('a[href]')).filter(
        (a) =>
          !a.classList.contains('for-nvda') &&
          !a.classList.contains('screenreader-only') &&
          !a.classList.contains('sr-only') &&
          a.getAttribute('aria-hidden') !== 'true'
      );

      const linkEl =
        allLinks.find(
          (a) =>
            a.matches('a.ig-title.item_link, a.ig-title, a.item_link') &&
            a.getBoundingClientRect().width > 0
        ) ||
        allLinks.find((a) => a.matches('a.ig-title.item_link, a.ig-title, a.item_link')) ||
        allLinks.find(
          (a) =>
            /\/(?:modules\/items|quizzes|pages|assignments|discussion_topics)\//i.test(
              a.getAttribute('href') || ''
            ) && a.getBoundingClientRect().width > 0
        ) ||
        allLinks[0];

      if (!linkEl) continue;
      if (linkEl.getAttribute('data-lms-nav-visited') === 'true') continue;

      const rawHref = (linkEl.href || linkEl.getAttribute('href') || '').split('#')[0].trim();
      if (!rawHref || /^javascript:/i.test(rawHref)) continue;

      const label = this.cleanText(
        linkEl.getAttribute('title') || linkEl.innerText || linkEl.textContent || 'Module Item'
      );
      if (!label) continue;

      const isCanvasCompleted =
        Boolean(
          li.querySelector(
            '.module-item-status-icon .icon-check, .completion_status .icon-check, i.icon-check[title*="Completed" i], i.icon-check[aria-label*="Completed" i]'
          )
        ) || /\bcompleted\b/i.test(li.className || '');

      const isVisited = this.isModuleUrlVisited(rawHref);
      const isGeneralDiscussion =
        /\b(general\s*discussion|forum\s*diskusi|q\s*&\s*a|course\s*support)\b/i.test(label) ||
        Boolean(li.querySelector('.icon-discussion'));

      candidates.push({
        el: linkEl,
        label,
        href: rawHref,
        isCanvasCompleted,
        isVisited,
        isGeneralDiscussion
      });
    }

    // Fallback langsung jika tema Canvas menggunakan struktur tautan `/modules/items/` tanpa `li.context_module_item`
    if (candidates.length === 0) {
      const directLinks = Array.from(
        document.querySelectorAll('#context_modules a[href*="/modules/items/"], main a[href*="/modules/items/"]')
      ).filter(
        (a) =>
          !a.classList.contains('for-nvda') &&
          !a.classList.contains('screenreader-only') &&
          a.getBoundingClientRect().width > 0 &&
          a.getAttribute('data-lms-nav-visited') !== 'true'
      );
      for (const a of directLinks) {
        const rawHref = (a.href || a.getAttribute('href') || '').split('#')[0].trim();
        const label = this.cleanText(a.getAttribute('title') || a.innerText || a.textContent || 'Module Item');
        if (!rawHref || !label) continue;
        candidates.push({
          el: a,
          label,
          href: rawHref,
          isCanvasCompleted: false,
          isVisited: this.isModuleUrlVisited(rawHref),
          isGeneralDiscussion: /\b(general\s*discussion)\b/i.test(label)
        });
      }
    }

    if (candidates.length === 0) return null;

    // Prioritas 1: Item yang belum selesai di Canvas, belum dikunjungi di sesi ini, dan bukan General Discussion
    const prio1 = candidates.find((c) => !c.isCanvasCompleted && !c.isVisited && !c.isGeneralDiscussion);
    if (prio1) return prio1;

    // Prioritas 2: Item apa pun yang belum selesai di Canvas dan belum dikunjungi di sesi ini
    const prio2 = candidates.find((c) => !c.isCanvasCompleted && !c.isVisited);
    if (prio2) return prio2;

    // Prioritas 3: Jika masih ada modul yang terlipat (collapsed) dan semua modul yang terbuka sudah dikunjungi, buka modul berikutnya!
    const collapsedModuleHeader = document.querySelector(
      '.context_module.collapsed_module .ig-header, .collapse_module_link[aria-expanded="false"]'
    );
    if (collapsedModuleHeader && collapsedModuleHeader.getBoundingClientRect().width > 0) {
      return {
        el: collapsedModuleHeader,
        label: this.cleanText(collapsedModuleHeader.innerText || 'Expand Next Module'),
        href: ''
      };
    }

    // Prioritas 4: Item pertama yang belum selesai di Canvas (meskipun sudah pernah dikunjungi sebelumnya)
    const prio3 = candidates.find((c) => !c.isCanvasCompleted && !c.isGeneralDiscussion);
    if (prio3) return prio3;

    // Prioritas 5: Item pertama yang belum dikunjungi pada sesi ini
    const prio4 = candidates.find((c) => !c.isVisited && !c.isGeneralDiscussion);
    if (prio4) return prio4;

    return candidates[0];
  },

  /**
   * Cari tombol panah kanan `>` (Next Slide / Next Question) pada Carousel Assessment (seperti pada NetAcad Assessment)
   */
  findCarouselNextButton(runBtnIds = new Set()) {
    const win = window;
    const vw = win.innerWidth || document.documentElement?.clientWidth || 1024;
    const vh = win.innerHeight || document.documentElement?.clientHeight || 768;

    const candidates = this.queryAllDeep('button, [role="button"], a, div, span').filter((el) => {
      if (!this.isVisible(el) || el.disabled) return false;
      if (this.isInsideSidebarOrHeader(el)) return false;
      if (el.getAttribute('data-lms-nav-visited') === 'true') return false;
      const autoId = el.getAttribute('data-lms-auto-id');
      if (autoId && runBtnIds.has(autoId)) return false;

      const style = (el.ownerDocument?.defaultView || window).getComputedStyle(el);
      if (parseFloat(style.opacity) <= 0.35 || style.pointerEvents === 'none') return false;

      const meta = `${el.className || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-action') || ''}`;
      if (
        /\b(disabled|is-disabled|swiper-button-disabled|slick-disabled|prev|previous|back|left|close|chat|help|support|assistant|fullscreen|expand|minimize)\b/i.test(
          meta
        )
      ) {
        return false;
      }
      if (el.getAttribute('aria-disabled') === 'true') return false;

      const rect = el.getBoundingClientRect();
      // Harus berukuran tombol navigasi kompak dan berada di paruh kanan layar (serta di bawah header atas)
      if (rect.width < 18 || rect.width > 80 || rect.height < 22 || rect.height > 95) return false;
      if (rect.left < vw * 0.5 || rect.top < 140) return false;

      return true;
    });

    // Saring agar hanya memilih elemen tombol terluar (bukan <svg> atau <span> di dalam <button>)
    const outerBtns = candidates.filter(
      (el) => !candidates.some((other) => other !== el && other.contains(el))
    );

    for (const el of outerBtns) {
      const rect = el.getBoundingClientRect();
      const txt = this.cleanText(el.innerText || el.value || '');
      const meta = `${el.className || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;

      // 1. Atribut / class eksplisit untuk next slide / arrow right
      if (
        /\b(carousel-control-next|swiper-button-next|slick-next|next-slide|slide-next|arrow-right|chevron-right|nav-next|btn-next)\b/i.test(
          meta
        ) ||
        /\b(next\s*question|next\s*slide|soal\s*berikutnya)\b/i.test(meta)
      ) {
        return { el, label: 'Soal Berikutnya (>)' };
      }

      // 2. Teks tombol adalah simbol panah kanan tunggal (`>`, `›`, `»`, `→`)
      if (/^[>›»→➔⟶\u203A\u276F]$/.test(txt)) {
        return { el, label: 'Soal Berikutnya (>)' };
      }

      // 3. Tombol ikon (<svg> / <i>) di tepi kanan panel konten (seperti tombol kotak hijau `>` pada NetAcad Assessment)
      if (txt.length <= 2 && rect.left >= vw * 0.85 && rect.top >= vh * 0.34 && rect.bottom <= vh - 15) {
        const hasIcon = Boolean(el.querySelector('svg, path, i, img'));
        const winEl = el.ownerDocument?.defaultView || window;
        const style = winEl.getComputedStyle(el);
        const isClickable =
          el.tagName === 'BUTTON' ||
          el.getAttribute('role') === 'button' ||
          style.cursor === 'pointer';

        if (hasIcon && isClickable) {
          // Pastikan bukan lingkaran mengambang chat/bantuan (tombol `>` pada NetAcad berbentuk kotak/persegi panjang dengan tinggi >= lebar atau memiliki pasangan `<` di kiri)
          const borderRadius = parseFloat(style.borderRadius) || 0;
          const isFullCircle = Math.abs(rect.width - rect.height) <= 4 && borderRadius >= rect.width * 0.45;
          if (!isFullCircle || /\b(next|right|forward)\b/i.test(meta)) {
            return { el, label: 'Soal Berikutnya (>)' };
          }
        }
      }
    }

    return null;
  },

  /**
   * Cari item sub-modul berikutnya pada Course Outline / Sidebar kiri (misal dari "Art as Data" -> "Explore painting" pada NetAcad).
   * PENTING: Jangan pernah menganggap menu kiri Canvas LMS (`Home`, `Announcements`, `Modules`, `Discussions`, `Grades`, `Lucid`, `Notebook`)
   * sebagai daftar sub-modul!
   */
  findNextOutlineItem() {
    // Pada Canvas LMS (`instructure.com` atau halaman dengan `#section-tabs`), menu kiri adalah tab kursus (Home..Notebook),
    // BUKAN urutan bab materi! Navigasi modul Canvas ditangani oleh `findNextModuleIndexItem()` dan `.module-sequence-footer`.
    if (
      document.querySelector('#section-tabs, ul#section-tabs, .ic-app-course-menu') ||
      /instructure\.com/i.test(window.location.hostname || '')
    ) {
      return null;
    }

    const genericMenuTabRegex =
      /^(?:home|beranda|announcements?|pengumuman|modules?|modul|discussions?|diskusi|grades?(?:\s+\d+)?|nilai|people|peserta|pages|files|berkas|syllabus|silabus|outcomes|quizzes|conferences|collaborations|settings|pengaturan|lucid(?:\s*\(whiteboard\))?|whiteboard|notebook|badges|credentials|account|dashboard|courses|calendar|inbox|history|help)$/i;

    // Cari kontainer sidebar / course outline
    const allContainers = this.queryAllDeep(
      'aside, nav, [role="navigation"], [role="tree"], .sidebar, .course-outline, [class*="sidebar"], [class*="outline"], div'
    ).filter((el) => this.isVisible(el) && this.isInsideSidebarOrHeader(el));

    if (allContainers.length === 0) return null;

    // Cari judul halaman aktif di area konten utama (misal "Assessment" atau "Art as Data")
    const mainHeaders = this.queryAllDeep('h1, h2, [class*="title"], [class*="header"]')
      .filter((el) => this.isVisible(el) && !this.isInsideSidebarOrHeader(el))
      .map((el) => this.cleanText(el.innerText || '').replace(/^[=<≡☰\s]+/, '').trim())
      .filter((t) => t.length >= 3 && t.length <= 90);

    // Kumpulkan semua item menu klik di dalam sidebar (abaikan header induk grup yang memiliki "0 / 10", "1 / 3", atau "100 Pts")
    const rawItems = this.queryAllDeep('a, button, [role="treeitem"], [role="menuitem"], [role="button"], li, div', document)
      .filter((el) => {
        if (!this.isVisible(el) || !this.isInsideSidebarOrHeader(el)) return false;
        if (el.closest && el.closest('#section-tabs, #header, .ic-app-header')) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width < 80 || rect.width > 380 || rect.height < 20 || rect.height > 62) return false;
        const txt = this.cleanText(el.innerText || '');
        if (!txt || txt.length < 3 || txt.length > 85) return false;
        if (/^(course\s*outline|resources|search\s*course)/i.test(txt)) return false;
        if (genericMenuTabRegex.test(txt)) return false;
        // Abaikan baris induk bab yang menampilkan penghitung seperti "1 / 3", "0 / 9", "100 Pts"
        if (/\b\d+\s*\/\s*\d+\b|\b\d+\s*pts\b/i.test(txt)) return false;
        const win = el.ownerDocument?.defaultView || window;
        const style = win.getComputedStyle(el);
        return (
          el.tagName === 'A' ||
          el.tagName === 'BUTTON' ||
          el.getAttribute('role') === 'treeitem' ||
          style.cursor === 'pointer'
        );
      });

    // Ambil leaf item per baris vertikal (agar tidak menduplikasi <li> dan <a> di dalamnya)
    const outlineItems = [];
    for (const item of rawItems) {
      if (rawItems.some((other) => other !== item && item.contains(other))) continue;
      const rect = item.getBoundingClientRect();
      if (outlineItems.some((prev) => Math.abs(prev.rect.top - rect.top) < 10)) continue;
      outlineItems.push({
        el: item,
        rect,
        label: this.cleanText(item.innerText || '')
      });
    }

    if (outlineItems.length < 2) return null;
    outlineItems.sort((a, b) => a.rect.top - b.rect.top);

    // 1. Cari berdasarkan kecocokan PERSIS (Exact Match) dengan judul di panel kanan terlebih dahulu!
    //    (Penting agar "Assessment" tidak tertukar dengan "Chapter 3 Assessment")
    let activeIdx = -1;
    if (mainHeaders.length > 0) {
      activeIdx = outlineItems.findIndex(({ label }) => {
        const cleanLbl = label.toLowerCase();
        return mainHeaders.some((h) => h.toLowerCase() === cleanLbl);
      });
    }

    // 2. Cek atribut aria-current / class active eksplisit pada item daun
    if (activeIdx === -1) {
      activeIdx = outlineItems.findIndex(({ el }) => {
        const cls = `${el.className || ''} ${el.parentElement?.className || ''}`;
        return (
          el.getAttribute('aria-current') === 'page' ||
          el.getAttribute('aria-current') === 'true' ||
          el.getAttribute('aria-selected') === 'true' ||
          /\b(active|is-active|current|selected|is-selected)\b/i.test(cls)
        );
      });
    }

    // 3. Cek item yang dicetak tebal (font-weight >= 600) di sidebar seperti pada NetAcad
    if (activeIdx === -1) {
      activeIdx = outlineItems.findIndex(({ el }) => {
        const win = el.ownerDocument?.defaultView || window;
        const fw = parseInt(win.getComputedStyle(el).fontWeight, 10);
        return fw >= 600;
      });
    }

    // 4. Fallback terakhir: kecocokan sebagian (substring)
    if (activeIdx === -1 && mainHeaders.length > 0) {
      activeIdx = outlineItems.findIndex(({ label }) => {
        const cleanLbl = label.toLowerCase();
        return cleanLbl.length >= 4 && mainHeaders.some((h) => h.toLowerCase().includes(cleanLbl));
      });
    }

    if (activeIdx !== -1 && activeIdx + 1 < outlineItems.length) {
      for (let nextIdx = activeIdx + 1; nextIdx < outlineItems.length; nextIdx++) {
        const nextCandidate = outlineItems[nextIdx];
        if (nextCandidate.el.getAttribute('data-lms-nav-visited') === 'true') {
          continue;
        }
        return {
          el: nextCandidate.el,
          label: nextCandidate.label
        };
      }
    }

    return null;
  }
};

if (typeof globalThis !== 'undefined') {
  globalThis.LMSScanner = LMSScanner;
}
